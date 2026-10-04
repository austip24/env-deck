//! `~/.envdeck.json`: the only file EnvDeck writes for itself.
//!
//! Every key is optional. Paths are stored `~`-relative (with `/`) so the file is portable
//! between machines, and keys EnvDeck doesn't know are kept on save.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::fsops;

pub const CONFIG_ENV: &str = "ENVDECK_CONFIG";
pub const FILE_NAME: &str = ".envdeck.json";

pub const DEFAULT_INCLUDE: &[&str] = &[
    ".env",
    ".env.*",
    "*.env",
    ".npmrc",
    ".yarnrc.yml",
    "appsettings*.json",
    "application*.yml",
    "application*.yaml",
    "application*.properties",
    "docker-compose*.yml",
    "docker-compose*.yaml",
    "compose*.yaml",
    ".vscode/launch.json",
    ".vscode/settings.json",
];

pub const DEFAULT_EXCLUDE_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    "build",
    "bin",
    "obj",
    ".next",
    ".nuxt",
    ".venv",
    "venv",
    "__pycache__",
    ".gradle",
    ".idea",
    "AppData",
    "Library",
];

pub const DEFAULT_MAX_DEPTH: usize = 8;
pub const DEFAULT_MAX_FILE_BYTES: u64 = 512 * 1024;

/// The file as written by the user. Unknown keys are kept in `extra`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Manifest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub roots: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub library: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exclude_dirs: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_depth: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_file_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub editor: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Editor {
    #[default]
    Vscode,
    VscodeInsiders,
    Cursor,
    Windsurf,
}

impl Editor {
    const ALL: [Editor; 4] = [
        Editor::Vscode,
        Editor::VscodeInsiders,
        Editor::Cursor,
        Editor::Windsurf,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Editor::Vscode => "vscode",
            Editor::VscodeInsiders => "vscode-insiders",
            Editor::Cursor => "cursor",
            Editor::Windsurf => "windsurf",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|e| e.as_str() == s)
    }
}

/// Scan settings with defaults applied.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub include: Vec<String>,
    pub exclude_dirs: Vec<String>,
    pub max_depth: usize,
    pub max_file_bytes: u64,
    pub editor: Editor,
}

/// The settings the webview may change through `save_manifest`. Deliberately has no `roots` or
/// `library`: those change only through native pickers, so the page can't grant itself access.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsUpdate {
    pub include: Option<Vec<String>>,
    pub exclude_dirs: Option<Vec<String>>,
    pub max_depth: Option<usize>,
    pub max_file_bytes: Option<u64>,
    pub editor: Option<Editor>,
}

fn strings(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

impl Manifest {
    /// Settings with defaults applied, plus warnings about values that were ignored.
    pub fn settings(&self) -> (Settings, Vec<String>) {
        let mut warnings = Vec::new();
        let editor = match self.editor.as_deref() {
            None => Editor::default(),
            Some(s) => Editor::parse(s).unwrap_or_else(|| {
                warnings.push(format!(
                    "Unknown editor \"{s}\"; using vscode (options: vscode, vscode-insiders, cursor, windsurf)"
                ));
                Editor::default()
            }),
        };
        let settings = Settings {
            include: self
                .include
                .clone()
                .unwrap_or_else(|| strings(DEFAULT_INCLUDE)),
            exclude_dirs: self
                .exclude_dirs
                .clone()
                .unwrap_or_else(|| strings(DEFAULT_EXCLUDE_DIRS)),
            max_depth: self.max_depth.unwrap_or(DEFAULT_MAX_DEPTH),
            max_file_bytes: self.max_file_bytes.unwrap_or(DEFAULT_MAX_FILE_BYTES),
            editor,
        };
        (settings, warnings)
    }

    pub fn apply(&mut self, update: SettingsUpdate) {
        if let Some(v) = update.include {
            self.include = Some(v);
        }
        if let Some(v) = update.exclude_dirs {
            self.exclude_dirs = Some(v);
        }
        if let Some(v) = update.max_depth {
            self.max_depth = Some(v);
        }
        if let Some(v) = update.max_file_bytes {
            self.max_file_bytes = Some(v);
        }
        if let Some(v) = update.editor {
            self.editor = Some(v.as_str().to_string());
        }
    }

    /// Saved roots, `~`-expanded.
    pub fn root_paths(&self, home: Option<&Path>) -> Vec<PathBuf> {
        self.roots
            .iter()
            .flatten()
            .map(|r| expand_with(r, home))
            .collect()
    }

    pub fn library_path(&self, home: Option<&Path>) -> Option<PathBuf> {
        self.library.as_deref().map(|l| expand_with(l, home))
    }

    /// Adds a saved root (stored `~`-relative). Returns false if it was already there.
    pub fn add_root(&mut self, path: &Path, home: Option<&Path>) -> bool {
        if self.root_paths(home).iter().any(|r| same_path(r, path)) {
            return false;
        }
        self.roots
            .get_or_insert_with(Vec::new)
            .push(contract_with(path, home));
        true
    }

    /// Removes a saved root. Returns false if it wasn't saved.
    pub fn remove_root(&mut self, path: &Path, home: Option<&Path>) -> bool {
        let Some(roots) = self.roots.as_mut() else {
            return false;
        };
        let before = roots.len();
        roots.retain(|r| !same_path(&expand_with(r, home), path));
        roots.len() != before
    }

    pub fn set_library(&mut self, path: &Path, home: Option<&Path>) {
        self.library = Some(contract_with(path, home));
    }
}

/// Compares paths, ignoring case on Windows and canonicalising when both exist.
pub fn same_path(a: &Path, b: &Path) -> bool {
    let canon = |p: &Path| dunce::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let (a, b) = (canon(a), canon(b));
    if cfg!(windows) {
        a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
    } else {
        a == b
    }
}

pub fn home() -> Option<PathBuf> {
    dirs::home_dir()
}

/// `ENVDECK_CONFIG` if set, else `~/.envdeck.json`.
pub fn config_path() -> Result<PathBuf> {
    config_path_from(
        std::env::var_os(CONFIG_ENV).map(PathBuf::from),
        home().as_deref(),
    )
}

fn config_path_from(env: Option<PathBuf>, home: Option<&Path>) -> Result<PathBuf> {
    match (env, home) {
        (Some(p), _) if !p.as_os_str().is_empty() => Ok(expand_with(&p.to_string_lossy(), home)),
        (_, Some(h)) => Ok(h.join(FILE_NAME)),
        _ => Err(Error::Manifest(
            "can't find the home folder; set ENVDECK_CONFIG".into(),
        )),
    }
}

/// Loads the manifest. A missing file is an empty manifest; a malformed one is an error (and
/// must not be overwritten).
pub fn load(path: &Path) -> Result<Manifest> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Manifest::default()),
        Err(e) => return Err(Error::Manifest(format!("{}: {e}", path.display()))),
    };
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    if text.trim().is_empty() {
        return Ok(Manifest::default());
    }
    serde_json::from_str(text).map_err(|e| Error::Manifest(format!("{}: {e}", path.display())))
}

/// Writes the manifest as pretty JSON with a trailing newline, atomically.
pub fn save(path: &Path, manifest: &Manifest) -> Result<()> {
    let mut json =
        serde_json::to_string_pretty(manifest).map_err(|e| Error::Manifest(e.to_string()))?;
    json.push('\n');
    fsops::write_atomic(path, json.as_bytes())
}

pub fn expand(s: &str) -> PathBuf {
    expand_with(s, home().as_deref())
}

pub fn contract(path: &Path) -> String {
    contract_with(path, home().as_deref())
}

/// Expands a leading `~`, `~/` or `~\` against `home`.
pub fn expand_with(s: &str, home: Option<&Path>) -> PathBuf {
    let Some(home) = home else {
        return PathBuf::from(s);
    };
    if s == "~" {
        return home.to_path_buf();
    }
    match s.strip_prefix("~/").or_else(|| s.strip_prefix("~\\")) {
        Some(rest) => rest
            .split(['/', '\\'])
            .filter(|c| !c.is_empty())
            .fold(home.to_path_buf(), |p, c| p.join(c)),
        None => PathBuf::from(s),
    }
}

/// `~`-relative form of `path` with `/` separators when it's inside `home`; otherwise the
/// native path unchanged.
pub fn contract_with(path: &Path, home: Option<&Path>) -> String {
    if let Some(home) = home
        && let Ok(rest) = strip_prefix_ci(path, home)
    {
        let parts: Vec<String> = rest
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect();
        return if parts.is_empty() {
            "~".to_string()
        } else {
            format!("~/{}", parts.join("/"))
        };
    }
    path.to_string_lossy().into_owned()
}

/// `Path::strip_prefix`, case-insensitive on Windows.
fn strip_prefix_ci<'a>(path: &'a Path, base: &Path) -> std::result::Result<&'a Path, ()> {
    if let Ok(rest) = path.strip_prefix(base) {
        return Ok(rest);
    }
    if !cfg!(windows) {
        return Err(());
    }
    let mut components = path.components();
    for b in base.components() {
        match components.next() {
            Some(p)
                if p.as_os_str().to_string_lossy().to_lowercase()
                    == b.as_os_str().to_string_lossy().to_lowercase() => {}
            _ => return Err(()),
        }
    }
    Ok(components.as_path())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home_dir() -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(r"C:\Users\dev")
        } else {
            PathBuf::from("/Users/dev")
        }
    }

    #[test]
    fn defaults_apply_when_keys_are_missing() {
        let (s, warnings) = Manifest::default().settings();
        assert!(warnings.is_empty());
        assert_eq!(s.max_depth, 8);
        assert_eq!(s.max_file_bytes, 524_288);
        assert_eq!(s.editor, Editor::Vscode);
        assert!(s.include.contains(&".env.*".to_string()));
        for d in ["node_modules", "bin", "obj", "AppData", "Library"] {
            assert!(s.exclude_dirs.contains(&d.to_string()), "{d}");
        }
    }

    #[test]
    fn partial_file_overrides_only_its_keys() {
        let m: Manifest = serde_json::from_str(r#"{ "maxDepth": 3, "editor": "cursor" }"#).unwrap();
        let (s, _) = m.settings();
        assert_eq!(s.max_depth, 3);
        assert_eq!(s.editor, Editor::Cursor);
        assert_eq!(s.max_file_bytes, DEFAULT_MAX_FILE_BYTES);
        assert_eq!(s.include.len(), DEFAULT_INCLUDE.len());
    }

    #[test]
    fn unknown_editor_falls_back_with_a_warning() {
        let m = Manifest {
            editor: Some("notepad".into()),
            ..Default::default()
        };
        let (s, warnings) = m.settings();
        assert_eq!(s.editor, Editor::Vscode);
        assert_eq!(warnings.len(), 1);
    }

    #[test]
    fn round_trip_keeps_unknown_keys_and_adds_none() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let original = "{\n  \"roots\": [\"~/code\"],\n  \"$comment\": \"mine\",\n  \"future\": {\"x\": 1}\n}\n";
        std::fs::write(&path, original).unwrap();
        let m = load(&path).unwrap();
        assert_eq!(m.extra.len(), 2);
        save(&path, &m).unwrap();
        let saved: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let keys: Vec<&String> = saved.as_object().unwrap().keys().collect();
        assert_eq!(keys.len(), 3, "{keys:?}");
        assert_eq!(saved["future"]["x"], 1);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.ends_with("}\n"));
        assert!(text.contains("\n  \"roots\""), "pretty-printed: {text}");
    }

    #[test]
    fn empty_manifest_saves_as_empty_object() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        save(&path, &Manifest::default()).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{}\n");
    }

    #[test]
    fn load_missing_empty_and_malformed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        assert_eq!(load(&path).unwrap(), Manifest::default());
        std::fs::write(&path, "  \n").unwrap();
        assert_eq!(load(&path).unwrap(), Manifest::default());
        std::fs::write(&path, "{ not json").unwrap();
        assert!(matches!(load(&path), Err(Error::Manifest(_))));
        std::fs::write(&path, r#"{ "maxDepth": "deep" }"#).unwrap();
        assert!(matches!(load(&path), Err(Error::Manifest(_))));
        std::fs::write(&path, "\u{feff}{ \"maxDepth\": 2 }").unwrap();
        assert_eq!(load(&path).unwrap().max_depth, Some(2));
    }

    #[test]
    fn config_path_prefers_env_override() {
        let home = home_dir();
        assert_eq!(
            config_path_from(None, Some(&home)).unwrap(),
            home.join(".envdeck.json")
        );
        assert_eq!(
            config_path_from(Some(PathBuf::from("~/cfg/envdeck.json")), Some(&home)).unwrap(),
            home.join("cfg").join("envdeck.json")
        );
        assert_eq!(
            config_path_from(Some(PathBuf::new()), Some(&home)).unwrap(),
            home.join(".envdeck.json")
        );
        assert!(config_path_from(None, None).is_err());
    }

    #[test]
    fn expand_handles_both_separators() {
        let home = home_dir();
        let h = Some(home.as_path());
        assert_eq!(expand_with("~", h), home);
        assert_eq!(expand_with("~/code/api", h), home.join("code").join("api"));
        assert_eq!(expand_with(r"~\code\api", h), home.join("code").join("api"));
        assert_eq!(expand_with("~other/x", h), PathBuf::from("~other/x"));
        assert_eq!(expand_with("/abs/path", h), PathBuf::from("/abs/path"));
        assert_eq!(expand_with("~/x", None), PathBuf::from("~/x"));
    }

    #[test]
    fn contract_uses_forward_slashes_inside_home() {
        let home = home_dir();
        let h = Some(home.as_path());
        assert_eq!(contract_with(&home, h), "~");
        assert_eq!(
            contract_with(&home.join("code").join("api"), h),
            "~/code/api"
        );
        let outside = if cfg!(windows) {
            PathBuf::from(r"D:\work\clients")
        } else {
            PathBuf::from("/opt/work")
        };
        assert_eq!(contract_with(&outside, h), outside.to_string_lossy());
        // Sibling with a shared prefix is not inside home.
        let sibling = PathBuf::from(format!("{}2", home.display())).join("x");
        assert_eq!(contract_with(&sibling, h), sibling.to_string_lossy());
        // Round trip.
        let p = home.join("dev-configs");
        assert_eq!(expand_with(&contract_with(&p, h), h), p);
    }

    #[cfg(windows)]
    #[test]
    fn contract_is_case_insensitive_on_windows() {
        let home = home_dir();
        assert_eq!(
            contract_with(Path::new(r"c:\users\DEV\code"), Some(&home)),
            "~/code"
        );
    }

    #[test]
    fn roots_and_library_are_stored_home_relative() {
        let home = home_dir();
        let h = Some(home.as_path());
        let mut m = Manifest::default();
        assert!(m.add_root(&home.join("code"), h));
        assert!(!m.add_root(&home.join("code"), h), "no duplicates");
        m.set_library(&home.join("dev-configs"), h);
        assert_eq!(m.roots.as_deref(), Some(&["~/code".to_string()][..]));
        assert_eq!(m.library.as_deref(), Some("~/dev-configs"));
        assert_eq!(m.root_paths(h), vec![home.join("code")]);
        assert!(m.remove_root(&home.join("code"), h));
        assert!(!m.remove_root(&home.join("code"), h));
        assert_eq!(m.roots.as_deref(), Some(&[][..]));
    }

    #[test]
    fn settings_update_cannot_touch_scope() {
        let err = serde_json::from_str::<SettingsUpdate>(r#"{ "roots": ["/"] }"#);
        assert!(err.is_err());
        let err = serde_json::from_str::<SettingsUpdate>(r#"{ "library": "/" }"#);
        assert!(err.is_err());

        let mut m = Manifest::default();
        let update: SettingsUpdate =
            serde_json::from_str(r#"{ "maxDepth": 4, "editor": "vscode-insiders" }"#).unwrap();
        m.apply(update);
        assert_eq!(m.max_depth, Some(4));
        assert_eq!(m.editor.as_deref(), Some("vscode-insiders"));
        assert!(m.roots.is_none() && m.library.is_none());
    }
}
