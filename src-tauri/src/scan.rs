//! Folder walk, glob matching, project detection and file kinds.
//!
//! Pure over the file system: no state, no Tauri. The `scan` command runs it on a blocking
//! thread. `.gitignore` is deliberately not honoured (`.env` files are usually git-ignored);
//! exclusions come from `excludeDirs` only.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Instant, UNIX_EPOCH};

use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use serde::Serialize;
use walkdir::WalkDir;

use crate::envfile::{is_dotenv_name, is_template_name};
use crate::manifest::{self, Settings};
use crate::state::RootSpec;

/// Stop after this many files across all roots, so a root pointed at `~` degrades gracefully.
pub const MAX_FILES: usize = 5_000;

/// A directory containing any of these is a project.
pub const PROJECT_MARKERS: &[&str] = &[
    ".git",
    "package.json",
    "Cargo.toml",
    "go.mod",
    "pyproject.toml",
    "global.json",
    "Directory.Build.props",
    "pom.xml",
    "build.gradle",
    "composer.json",
    "Gemfile",
    "deno.json",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FileKind {
    Env,
    EnvTemplate,
    Json,
    Yaml,
    Toml,
    Ini,
    Text,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigFile {
    pub path: PathBuf,
    pub root: PathBuf,
    /// Nearest ancestor (up to the root) with a project marker; else the file's own folder.
    pub project: PathBuf,
    pub project_name: String,
    /// The project folder relative to the root, `/`-separated (`""` when it is the root).
    pub project_rel_path: String,
    /// The file relative to its project, `/`-separated.
    pub rel_path: String,
    pub name: String,
    pub kind: FileKind,
    pub size: u64,
    pub modified_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RootState {
    Ok,
    Missing,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RootStatus {
    pub path: PathBuf,
    /// `~`-contracted for display.
    pub display: String,
    pub saved: bool,
    pub library: bool,
    pub status: RootState,
    pub message: Option<String>,
    pub file_count: usize,
    /// Entries that couldn't be read (e.g. permission denied); skipped, not fatal.
    pub skipped: usize,
    /// The file cap was hit while walking this root.
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub files: Vec<ConfigFile>,
    pub roots: Vec<RootStatus>,
    pub truncated: bool,
    /// Problems with the settings, e.g. an invalid include pattern (which is skipped).
    pub warnings: Vec<String>,
    pub elapsed_ms: u64,
}

/// `path` as a string with `/` separators, for glob matching and display.
pub fn slash(path: &Path) -> String {
    let s = path.to_string_lossy();
    if cfg!(windows) {
        s.replace('\\', "/")
    } else {
        s.into_owned()
    }
}

fn eq_name(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

/// Include globs and excluded directory names. Shared by the scanner and the watcher.
pub struct Matcher {
    include: GlobSet,
    exclude_dirs: Vec<String>,
}

impl Matcher {
    /// Builds the matcher; invalid patterns are skipped and reported as warnings.
    pub fn new(settings: &Settings) -> (Self, Vec<String>) {
        let mut warnings = Vec::new();
        let mut builder = GlobSetBuilder::new();
        for pattern in &settings.include {
            let anchored = match pattern.strip_prefix('/') {
                Some(rooted) => rooted.to_string(),
                None if pattern.starts_with("**/") => pattern.clone(),
                None => format!("**/{pattern}"),
            };
            match GlobBuilder::new(&anchored)
                .literal_separator(true)
                .case_insensitive(true)
                .build()
            {
                Ok(glob) => {
                    builder.add(glob);
                }
                Err(e) => warnings.push(format!("Ignoring include pattern \"{pattern}\": {e}")),
            }
        }
        let include = builder.build().unwrap_or_else(|e| {
            warnings.push(format!("Include patterns couldn't be compiled: {e}"));
            GlobSet::empty()
        });
        let matcher = Matcher {
            include,
            exclude_dirs: settings.exclude_dirs.clone(),
        };
        (matcher, warnings)
    }

    pub fn is_excluded_dir(&self, name: &str) -> bool {
        self.exclude_dirs.iter().any(|d| eq_name(d, name))
    }

    /// True if any component of `rel` (a path relative to a root) is an excluded directory.
    #[allow(dead_code)] // TODO(M8): used by the watcher
    pub fn in_excluded_dir(&self, rel: &Path) -> bool {
        let mut components = rel.components().peekable();
        while let Some(c) = components.next() {
            // The last component is the file itself.
            if components.peek().is_some() && self.is_excluded_dir(&c.as_os_str().to_string_lossy())
            {
                return true;
            }
        }
        false
    }

    /// Matches a root-relative path against the include globs.
    pub fn is_included(&self, rel: &Path) -> bool {
        self.include.is_match(slash(rel))
    }
}

pub fn kind_of(name: &str) -> FileKind {
    let lower = name.to_ascii_lowercase();
    if is_dotenv_name(&lower) {
        return if is_template_name(&lower) {
            FileKind::EnvTemplate
        } else {
            FileKind::Env
        };
    }
    if lower == ".npmrc" || lower == ".yarnrc" || lower == ".editorconfig" {
        return FileKind::Ini;
    }
    match lower.rsplit_once('.').map(|(_, ext)| ext) {
        Some("json" | "jsonc") => FileKind::Json,
        Some("yml" | "yaml") => FileKind::Yaml,
        Some("toml") => FileKind::Toml,
        Some("ini" | "cfg" | "conf" | "properties") => FileKind::Ini,
        _ => FileKind::Text,
    }
}

/// Finds and caches the project folder for each directory within one root.
struct Projects<'a> {
    root: &'a Path,
    cache: HashMap<PathBuf, Option<PathBuf>>,
}

impl Projects<'_> {
    fn has_marker(dir: &Path) -> bool {
        PROJECT_MARKERS.iter().any(|m| dir.join(m).exists())
    }

    /// Nearest ancestor of `dir` (inclusive, not above the root) with a marker.
    fn marked_ancestor(&mut self, dir: &Path) -> Option<PathBuf> {
        if let Some(hit) = self.cache.get(dir) {
            return hit.clone();
        }
        let found = if Self::has_marker(dir) {
            Some(dir.to_path_buf())
        } else if dir == self.root || !dir.starts_with(self.root) {
            None
        } else {
            match dir.parent() {
                Some(parent) => self.marked_ancestor(parent),
                None => None,
            }
        };
        self.cache.insert(dir.to_path_buf(), found.clone());
        found
    }

    fn project_for(&mut self, file: &Path) -> PathBuf {
        let dir = file.parent().unwrap_or(self.root);
        self.marked_ancestor(dir)
            .unwrap_or_else(|| dir.to_path_buf())
    }
}

fn modified_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64)
}

fn rel_slash(path: &Path, base: &Path) -> String {
    path.strip_prefix(base).map(slash).unwrap_or_default()
}

fn folder_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| slash(path))
}

pub fn scan(roots: &[RootSpec], settings: &Settings, home: Option<&Path>) -> ScanResult {
    scan_with_cap(roots, settings, home, MAX_FILES)
}

fn scan_with_cap(
    roots: &[RootSpec],
    settings: &Settings,
    home: Option<&Path>,
    cap: usize,
) -> ScanResult {
    let started = Instant::now();
    let (matcher, warnings) = Matcher::new(settings);
    let mut files: Vec<ConfigFile> = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut truncated = false;

    // Nested roots (e.g. a library inside a scanned folder): a file belongs to the most
    // specific root, so walk deeper roots first and skip files already claimed.
    let mut order: Vec<usize> = (0..roots.len()).collect();
    order.sort_by_key(|&i| std::cmp::Reverse(roots[i].path.components().count()));
    let mut by_index: Vec<Option<RootStatus>> = vec![None; roots.len()];

    for i in order {
        let spec = &roots[i];
        let mut status = RootStatus {
            path: spec.path.clone(),
            display: manifest::contract(&spec.path, home),
            saved: spec.saved,
            library: spec.library,
            status: RootState::Ok,
            message: None,
            file_count: 0,
            skipped: 0,
            truncated: false,
        };

        let root = match dunce::canonicalize(&spec.path) {
            Ok(r) if r.is_dir() => r,
            Ok(_) => {
                status.status = RootState::Error;
                status.message = Some("Not a folder".into());
                by_index[i] = Some(status);
                continue;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                status.status = RootState::Missing;
                status.message = Some("Folder not found".into());
                by_index[i] = Some(status);
                continue;
            }
            Err(e) => {
                status.status = RootState::Error;
                status.message = Some(e.to_string());
                by_index[i] = Some(status);
                continue;
            }
        };
        status.path = root.clone();

        if truncated {
            status.truncated = true;
            by_index[i] = Some(status);
            continue;
        }

        let mut projects = Projects {
            root: &root,
            cache: HashMap::new(),
        };
        let walker = WalkDir::new(&root)
            .follow_links(false)
            .max_depth(settings.max_depth)
            .sort_by_file_name()
            .into_iter()
            .filter_entry(|e| {
                e.depth() == 0
                    || !e.file_type().is_dir()
                    || !matcher.is_excluded_dir(&e.file_name().to_string_lossy())
            });

        for entry in walker {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => {
                    status.skipped += 1;
                    continue;
                }
            };
            let ft = entry.file_type();
            if ft.is_dir() {
                continue;
            }
            let path = entry.path();
            let Ok(rel) = path.strip_prefix(&root) else {
                continue;
            };
            if !matcher.is_included(rel) {
                continue;
            }
            // Symlinked files are listed only if they resolve to a file inside this root;
            // anything else would be refused by the scope guard on read anyway.
            let meta = if ft.is_symlink() {
                match dunce::canonicalize(path) {
                    Ok(target) if target.starts_with(&root) => std::fs::metadata(&target),
                    _ => continue,
                }
            } else {
                entry.metadata().map_err(std::io::Error::from)
            };
            let Ok(meta) = meta else {
                status.skipped += 1;
                continue;
            };
            if !meta.is_file() || !seen.insert(path.to_path_buf()) {
                continue;
            }
            if files.len() >= cap {
                truncated = true;
                status.truncated = true;
                break;
            }

            let project = projects.project_for(path);
            let name = entry.file_name().to_string_lossy().into_owned();
            files.push(ConfigFile {
                path: path.to_path_buf(),
                root: root.clone(),
                project_name: folder_name(&project),
                project_rel_path: rel_slash(&project, &root),
                rel_path: rel_slash(path, &project),
                kind: kind_of(&name),
                name,
                size: meta.len(),
                modified_ms: modified_ms(&meta),
                project,
            });
            status.file_count += 1;
        }
        by_index[i] = Some(status);
    }

    // Report in the caller's root order; files grouped by root, then project, then path.
    let root_rank: HashMap<PathBuf, usize> = by_index
        .iter()
        .enumerate()
        .filter_map(|(i, s)| s.as_ref().map(|s| (s.path.clone(), i)))
        .collect();
    files.sort_by(|a, b| {
        let ra = root_rank.get(&a.root).copied().unwrap_or(usize::MAX);
        let rb = root_rank.get(&b.root).copied().unwrap_or(usize::MAX);
        (ra, &a.project_rel_path, &a.rel_path).cmp(&(rb, &b.project_rel_path, &b.rel_path))
    });

    ScanResult {
        files,
        roots: by_index.into_iter().flatten().collect(),
        truncated,
        warnings,
        elapsed_ms: started.elapsed().as_millis() as u64,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn settings() -> Settings {
        manifest::Manifest::default().settings().0
    }

    fn touch(base: &Path, rel: &str) {
        let p = base.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, "A=1\n").unwrap();
    }

    fn root(path: &Path) -> RootSpec {
        RootSpec {
            path: path.to_path_buf(),
            saved: true,
            library: false,
        }
    }

    fn tempdir() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(dir.path()).unwrap();
        (dir, base)
    }

    /// Root-relative `/` paths of everything found.
    fn found(result: &ScanResult) -> Vec<String> {
        result
            .files
            .iter()
            .map(|f| rel_slash(&f.path, &f.root))
            .collect()
    }

    #[test]
    fn slash_normalises_separators() {
        let p = Path::new("a").join("b").join(".env");
        assert_eq!(slash(&p), "a/b/.env");
    }

    #[test]
    fn kinds() {
        let cases = [
            (".env", FileKind::Env),
            (".env.local", FileKind::Env),
            (".env.production.local", FileKind::Env),
            ("dev.env", FileKind::Env),
            (".env.example", FileKind::EnvTemplate),
            (".env.sample", FileKind::EnvTemplate),
            (".env.template", FileKind::EnvTemplate),
            (".env.dist", FileKind::EnvTemplate),
            (".env.defaults", FileKind::EnvTemplate),
            ("example.env", FileKind::EnvTemplate),
            (".ENV.EXAMPLE", FileKind::EnvTemplate),
            ("appsettings.Development.json", FileKind::Json),
            ("launch.json", FileKind::Json),
            ("application.yml", FileKind::Yaml),
            ("docker-compose.override.yaml", FileKind::Yaml),
            (".yarnrc.yml", FileKind::Yaml),
            ("Cargo.toml", FileKind::Toml),
            (".npmrc", FileKind::Ini),
            ("application.properties", FileKind::Ini),
            ("settings.ini", FileKind::Ini),
            ("README", FileKind::Text),
        ];
        for (name, kind) in cases {
            assert_eq!(kind_of(name), kind, "{name}");
        }
        // "distillery" contains "dist" but not as a dot-segment.
        assert_eq!(kind_of(".env.distillery"), FileKind::Env);
    }

    #[test]
    fn finds_nested_configs_and_prunes_excludes() {
        let (_d, base) = tempdir();
        for rel in [
            ".env",
            "apps/web/.env.local",
            "apps/web/.env.example",
            "apps/api/.vscode/launch.json",
            "apps/api/appsettings.Development.json",
            "apps/api/AppSettings.json",
            "node_modules/pkg/.env",
            "apps/web/node_modules/x/.env",
            "apps/api/bin/Debug/appsettings.json",
            "target/.env",
            "src/main.rs",
            ".env.d/not-a-match",
        ] {
            touch(&base, rel);
        }
        let result = scan(&[root(&base)], &settings(), None);
        let mut files = found(&result);
        files.sort();
        assert_eq!(
            files,
            [
                ".env",
                "apps/api/.vscode/launch.json",
                "apps/api/AppSettings.json",
                "apps/api/appsettings.Development.json",
                "apps/web/.env.example",
                "apps/web/.env.local",
            ]
        );
        assert_eq!(result.roots[0].status, RootState::Ok);
        assert_eq!(result.roots[0].file_count, 6);
        assert!(!result.truncated);
    }

    #[test]
    fn gitignore_is_not_honoured() {
        let (_d, base) = tempdir();
        touch(&base, ".gitignore");
        fs::write(base.join(".gitignore"), ".env\n*.env\n").unwrap();
        touch(&base, ".env");
        let result = scan(&[root(&base)], &settings(), None);
        assert_eq!(found(&result), [".env"]);
    }

    #[test]
    fn groups_by_nearest_marker() {
        let (_d, base) = tempdir();
        touch(&base, "repo/.git/HEAD");
        touch(&base, "repo/.env");
        touch(&base, "repo/apps/web/package.json");
        touch(&base, "repo/apps/web/config/.env");
        touch(&base, "repo/docs/.env.example");
        touch(&base, "loose/folder/.env");
        let result = scan(&[root(&base)], &settings(), None);
        let by_rel: HashMap<String, &ConfigFile> = result
            .files
            .iter()
            .map(|f| (rel_slash(&f.path, &f.root), f))
            .collect();

        let f = by_rel["repo/.env"];
        assert_eq!(
            (f.project_name.as_str(), f.rel_path.as_str()),
            ("repo", ".env")
        );
        let f = by_rel["repo/apps/web/config/.env"];
        assert_eq!(f.project, base.join("repo").join("apps").join("web"));
        assert_eq!(f.project_rel_path, "repo/apps/web");
        assert_eq!(f.rel_path, "config/.env");
        // No marker in docs/, so it belongs to the nearest marked ancestor: repo/.
        let f = by_rel["repo/docs/.env.example"];
        assert_eq!(f.project_name, "repo");
        assert_eq!(f.rel_path, "docs/.env.example");
        assert_eq!(f.kind, FileKind::EnvTemplate);
        // No marker anywhere: the file's own folder.
        let f = by_rel["loose/folder/.env"];
        assert_eq!(f.project, base.join("loose").join("folder"));
        assert_eq!(
            (f.project_name.as_str(), f.rel_path.as_str()),
            ("folder", ".env")
        );
    }

    #[test]
    fn marker_above_the_root_is_ignored() {
        let (_d, base) = tempdir();
        touch(&base, "package.json");
        touch(&base, "inner/sub/.env");
        let result = scan(&[root(&base.join("inner"))], &settings(), None);
        assert_eq!(result.files[0].project, base.join("inner").join("sub"));
    }

    #[test]
    fn respects_max_depth() {
        let (_d, base) = tempdir();
        touch(&base, "a/.env"); // depth 2
        touch(&base, "a/b/c/.env"); // depth 4
        let mut s = settings();
        s.max_depth = 3;
        let result = scan(&[root(&base)], &s, None);
        assert_eq!(found(&result), ["a/.env"]);
    }

    #[test]
    fn truncates_at_the_cap() {
        let (_d, base) = tempdir();
        for i in 0..5 {
            touch(&base, &format!("p{i}/.env"));
        }
        // Two roots: the nested one is walked first, the outer one hits the cap.
        let roots = [root(&base.join("p1")), root(&base)];
        let result = scan_with_cap(&roots, &settings(), None, 3);
        assert!(result.truncated);
        assert_eq!(result.files.len(), 3);
        assert!(!result.roots[0].truncated);
        assert!(result.roots[1].truncated);
    }

    #[test]
    fn missing_root_is_reported_not_fatal() {
        let (_d, base) = tempdir();
        touch(&base, "ok/.env");
        let roots = [root(&base.join("gone")), root(&base.join("ok"))];
        let result = scan(&roots, &settings(), None);
        assert_eq!(result.roots[0].status, RootState::Missing);
        assert_eq!(result.roots[1].status, RootState::Ok);
        assert_eq!(result.files.len(), 1);

        touch(&base, "file-root");
        let result = scan(&[root(&base.join("file-root"))], &settings(), None);
        assert_eq!(result.roots[0].status, RootState::Error);
    }

    #[test]
    fn nested_roots_dont_duplicate_and_keep_caller_order() {
        let (_d, base) = tempdir();
        touch(&base, "code/api/.env");
        touch(&base, "code/lib/.env.shared");
        let library = RootSpec {
            path: base.join("code").join("lib"),
            saved: true,
            library: true,
        };
        let result = scan(&[root(&base.join("code")), library], &settings(), None);
        assert_eq!(result.files.len(), 2);
        // The library file belongs to the more specific root.
        let shared = result
            .files
            .iter()
            .find(|f| f.name == ".env.shared")
            .unwrap();
        assert_eq!(shared.root, base.join("code").join("lib"));
        // Statuses and files follow the caller's root order.
        assert!(!result.roots[0].library && result.roots[1].library);
        assert_eq!(result.files[0].name, ".env");
    }

    #[test]
    fn invalid_include_pattern_is_a_warning() {
        let (_d, base) = tempdir();
        touch(&base, ".env");
        let mut s = settings();
        s.include = vec!["[unclosed".into(), ".env".into()];
        let result = scan(&[root(&base)], &s, None);
        assert_eq!(result.warnings.len(), 1);
        assert_eq!(found(&result), [".env"]);
    }

    #[test]
    fn rooted_patterns_only_match_at_the_root() {
        let (_d, base) = tempdir();
        touch(&base, "config.toml");
        touch(&base, "sub/config.toml");
        let mut s = settings();
        s.include = vec!["/config.toml".into()];
        let result = scan(&[root(&base)], &s, None);
        assert_eq!(found(&result), ["config.toml"]);
    }

    #[test]
    fn matcher_helpers_for_the_watcher() {
        let (m, _) = Matcher::new(&settings());
        assert!(m.is_included(Path::new("a/b/.env.local")));
        assert!(!m.is_included(Path::new("a/b/main.rs")));
        assert!(m.in_excluded_dir(&Path::new("web").join("node_modules").join(".env")));
        assert!(
            !m.in_excluded_dir(Path::new("node_modules")),
            "a file named like a dir"
        );
        assert!(!m.in_excluded_dir(&Path::new("web").join(".env")));
    }

    #[test]
    fn display_is_home_relative() {
        let (_d, base) = tempdir();
        touch(&base, "code/.env");
        let result = scan(&[root(&base.join("code"))], &settings(), Some(&base));
        assert_eq!(result.roots[0].display, "~/code");
    }

    #[test]
    fn serialises_for_the_ui() {
        let (_d, base) = tempdir();
        touch(&base, ".env.example");
        let json = serde_json::to_value(scan(&[root(&base)], &settings(), None)).unwrap();
        assert_eq!(json["files"][0]["kind"], "env-template");
        assert_eq!(json["files"][0]["relPath"], ".env.example");
        assert_eq!(json["roots"][0]["status"], "ok");
        assert!(json["elapsedMs"].is_number());
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_files_only_if_target_is_inside_the_root() {
        let (_d, base) = tempdir();
        touch(&base, "root/shared/real.env");
        touch(&base, "outside/secret.env");
        let r = base.join("root");
        std::os::unix::fs::symlink(r.join("shared").join("real.env"), r.join(".env")).unwrap();
        std::os::unix::fs::symlink(base.join("outside").join("secret.env"), r.join("leak.env"))
            .unwrap();
        let result = scan(&[root(&r)], &settings(), None);
        let mut files = found(&result);
        files.sort();
        assert_eq!(files, [".env", "shared/real.env"]);
    }

    /// Manual timing check against a real folder: `ENVDECK_SCAN_ROOT=~ cargo test scan_real -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn scan_real() {
        let Some(dir) = std::env::var_os("ENVDECK_SCAN_ROOT") else {
            return;
        };
        let home = manifest::home();
        let path = manifest::expand(&dir.to_string_lossy(), home.as_deref());
        let result = scan(&[root(&path)], &settings(), home.as_deref());
        eprintln!(
            "{} files, truncated={}, skipped={}, {} ms",
            result.files.len(),
            result.truncated,
            result.roots[0].skipped,
            result.elapsed_ms
        );
    }
}
