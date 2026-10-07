//! In-memory session state and the scope guard.
//!
//! Nothing here is persisted: session folders and destination grants are forgotten on
//! quit.
//! Commands copy what they need out of the lock (`read_scopes`, `write_scopes`, ...) and never
//! hold it across `.await` or a blocking dialog.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use crate::error::{Error, Result};
use crate::fsops::validate_file_name;
use crate::manifest::{self, Manifest, Settings};

#[derive(Default)]
pub struct AppState(Mutex<Inner>);

impl AppState {
    pub fn new(inner: Inner) -> Self {
        AppState(Mutex::new(inner))
    }

    /// Locks the state. A panic while holding the lock leaves plain data behind, so a poisoned
    /// lock is recovered rather than propagated.
    pub fn lock(&self) -> MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[derive(Debug, Default)]
pub struct Inner {
    pub config_path: PathBuf,
    pub home: Option<PathBuf>,
    pub manifest: Manifest,
    /// Why the manifest couldn't be loaded; while set, the manifest is never saved over.
    pub manifest_error: Option<String>,
    /// Folders opened "for this session": scanned but not written to the manifest.
    pub session_roots: Vec<PathBuf>,
    /// Folders picked in a native destination dialog this session; writable, not readable.
    pub dest_grants: Vec<PathBuf>,
    /// File watchers for the current roots; replaced by `watch::restart`.
    pub watcher: Option<crate::watch::WatchHandle>,
    /// App Service resource ids (lowercase) that `az` listed this session. Push to Azure only
    /// targets these, so the page can't name an arbitrary resource.
    pub azure_sites: HashSet<String>,
}

/// A root to scan, as the scanner needs it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RootSpec {
    pub path: PathBuf,
    pub saved: bool,
    pub library: bool,
}

impl Inner {
    pub fn settings(&self) -> Settings {
        self.manifest.settings().0
    }

    /// Saved roots, then session roots, then the library.
    pub fn scan_roots(&self) -> Vec<RootSpec> {
        let home = self.home.as_deref();
        let saved = self
            .manifest
            .root_paths(home)
            .into_iter()
            .map(|path| RootSpec {
                path,
                saved: true,
                library: false,
            });
        let session = self.session_roots.iter().map(|p| RootSpec {
            path: p.clone(),
            saved: false,
            library: false,
        });
        let library = self.manifest.library_path(home).map(|path| RootSpec {
            path,
            saved: true,
            library: true,
        });
        saved.chain(session).chain(library).collect()
    }

    /// Where reads are allowed: every scan root and the library.
    pub fn read_scopes(&self) -> Vec<PathBuf> {
        self.scan_roots().into_iter().map(|r| r.path).collect()
    }

    /// Where writes are allowed: the read scopes plus destinations picked this session.
    pub fn write_scopes(&self) -> Vec<PathBuf> {
        let mut scopes = self.read_scopes();
        scopes.extend(self.dest_grants.iter().cloned());
        scopes
    }

    pub fn add_session_root(&mut self, path: PathBuf) {
        if !self
            .session_roots
            .iter()
            .any(|r| manifest::same_path(r, &path))
        {
            self.session_roots.push(path);
        }
    }

    pub fn grant_destination(&mut self, path: PathBuf) {
        if !self
            .dest_grants
            .iter()
            .any(|r| manifest::same_path(r, &path))
        {
            self.dest_grants.push(path);
        }
    }
}

/// Resolves `path` to its canonical form, or the canonical parent joined with the file name
/// when the file doesn't exist yet (a write target).
fn canonical_target(path: &Path) -> Result<PathBuf> {
    if path.symlink_metadata().is_ok() {
        return dunce::canonicalize(path).map_err(|e| Error::io(path, e));
    }
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| Error::InvalidName(path.display().to_string()))?;
    validate_file_name(name)?;
    let parent = path
        .parent()
        .ok_or_else(|| Error::OutOfScope(path.to_path_buf()))?;
    let parent = dunce::canonicalize(parent).map_err(|e| Error::io(parent, e))?;
    Ok(parent.join(name))
}

/// The scope guard. Every path from the webview goes through this before any file access.
///
/// Returns the canonical path if it is inside one of `scopes` (compared component-wise after
/// canonicalising both sides, so `..` and symlinks pointing elsewhere are resolved first).
pub fn ensure_within(path: &Path, scopes: &[PathBuf]) -> Result<PathBuf> {
    if !path.is_absolute() {
        return Err(Error::OutOfScope(path.to_path_buf()));
    }
    let canonical = canonical_target(path)?;
    let inside = scopes
        .iter()
        .any(|scope| dunce::canonicalize(scope).is_ok_and(|root| canonical.starts_with(&root)));
    if inside {
        Ok(canonical)
    } else {
        Err(Error::OutOfScope(path.to_path_buf()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct Tree {
        _dir: tempfile::TempDir,
        base: PathBuf,
        root: PathBuf,
    }

    /// base/{root/{app/.env}, root2/.env, outside/.env}
    fn tree() -> Tree {
        let dir = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(dir.path()).unwrap();
        let root = base.join("root");
        fs::create_dir_all(root.join("app")).unwrap();
        fs::create_dir_all(base.join("root2")).unwrap();
        fs::create_dir_all(base.join("outside")).unwrap();
        fs::write(root.join("app").join(".env"), "A=1").unwrap();
        fs::write(base.join("root2").join(".env"), "A=1").unwrap();
        fs::write(base.join("outside").join(".env"), "A=1").unwrap();
        Tree {
            _dir: dir,
            base,
            root,
        }
    }

    fn out_of_scope(r: Result<PathBuf>) -> bool {
        matches!(r, Err(Error::OutOfScope(_)))
    }

    #[test]
    fn inside_is_allowed_and_canonical() {
        let t = tree();
        let scopes = vec![t.root.clone()];
        let p = t.root.join("app").join(".env");
        assert_eq!(ensure_within(&p, &scopes).unwrap(), p);
        assert_eq!(ensure_within(&t.root, &scopes).unwrap(), t.root);
        // A non-canonical spelling that stays inside resolves and passes.
        let dotted = t.root.join("app").join("..").join("app").join(".env");
        assert_eq!(ensure_within(&dotted, &scopes).unwrap(), p);
    }

    #[test]
    fn outside_is_rejected() {
        let t = tree();
        let scopes = vec![t.root.clone()];
        assert!(out_of_scope(ensure_within(
            &t.base.join("outside").join(".env"),
            &scopes
        )));
        assert!(out_of_scope(ensure_within(&t.base, &scopes)));
        assert!(out_of_scope(ensure_within(
            &t.root.join("app").join(".env"),
            &[]
        )));
    }

    #[test]
    fn dot_dot_escape_is_rejected() {
        let t = tree();
        let scopes = vec![t.root.clone()];
        let escape = t.root.join("..").join("outside").join(".env");
        assert!(out_of_scope(ensure_within(&escape, &scopes)));
        // Also for a write target that doesn't exist yet.
        let escape_new = t
            .root
            .join("app")
            .join("..")
            .join("..")
            .join("outside")
            .join("new.env");
        assert!(out_of_scope(ensure_within(&escape_new, &scopes)));
    }

    #[test]
    fn sibling_with_shared_prefix_is_rejected() {
        let t = tree();
        let scopes = vec![t.root.clone()];
        assert!(out_of_scope(ensure_within(
            &t.base.join("root2").join(".env"),
            &scopes
        )));
    }

    #[test]
    fn relative_paths_are_rejected() {
        let t = tree();
        assert!(out_of_scope(ensure_within(
            Path::new("app/.env"),
            std::slice::from_ref(&t.root)
        )));
    }

    #[test]
    fn new_file_with_existing_parent_is_allowed() {
        let t = tree();
        let p = t.root.join("app").join(".env.local");
        assert_eq!(ensure_within(&p, std::slice::from_ref(&t.root)).unwrap(), p);
    }

    #[test]
    fn new_file_in_missing_folder_is_not_found() {
        let t = tree();
        let p = t.root.join("nope").join(".env");
        assert!(matches!(
            ensure_within(&p, std::slice::from_ref(&t.root)),
            Err(Error::NotFound(_))
        ));
    }

    #[test]
    fn bad_names_are_rejected() {
        let t = tree();
        let scopes = vec![t.root.clone()];
        assert!(ensure_within(&t.root.join("app").join(".."), &scopes).is_ok_and(|p| p == t.root));
        assert!(matches!(
            ensure_within(&t.root.join("app").join("bad:name"), &scopes),
            Err(Error::InvalidName(_))
        ));
    }

    #[test]
    fn missing_scope_root_grants_nothing() {
        let t = tree();
        let scopes = vec![t.base.join("gone")];
        assert!(out_of_scope(ensure_within(
            &t.root.join("app").join(".env"),
            &scopes
        )));
    }

    /// Symlinks (junctions on Windows) that point outside a root must fail, because the
    /// canonical target is what's checked.
    #[test]
    fn symlink_out_of_root_is_rejected() {
        let t = tree();
        let link = t.root.join("sneaky");
        let target = t.base.join("outside");
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(&target, &link).is_ok();
        // Directory symlinks need Developer Mode on Windows; junctions don't.
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_dir(&target, &link).is_ok()
            || std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(&link)
                .arg(&target)
                .output()
                .is_ok_and(|o| o.status.success());
        if !made {
            eprintln!("skipping: can't create a symlink or junction here");
            return;
        }
        let scopes = vec![t.root.clone()];
        assert!(out_of_scope(ensure_within(&link.join(".env"), &scopes)));
        assert!(out_of_scope(ensure_within(&link.join("new.env"), &scopes)));
    }

    #[test]
    fn write_grants_are_not_readable() {
        let t = tree();
        let inner = Inner {
            home: Some(t.base.clone()),
            manifest: Manifest {
                roots: Some(vec!["~/root".into()]),
                ..Default::default()
            },
            dest_grants: vec![t.base.join("outside")],
            ..Default::default()
        };
        let outside = t.base.join("outside").join(".env");
        assert!(out_of_scope(ensure_within(&outside, &inner.read_scopes())));
        assert!(ensure_within(&outside, &inner.write_scopes()).is_ok());
        assert!(ensure_within(&t.root.join("app").join(".env"), &inner.read_scopes()).is_ok());
    }

    #[test]
    fn scan_roots_order_and_flags() {
        let t = tree();
        let mut inner = Inner {
            home: Some(t.base.clone()),
            manifest: Manifest {
                roots: Some(vec!["~/root".into()]),
                library: Some("~/outside".into()),
                ..Default::default()
            },
            ..Default::default()
        };
        inner.add_session_root(t.base.join("root2"));
        inner.add_session_root(t.base.join("root2"));
        let roots = inner.scan_roots();
        assert_eq!(roots.len(), 3);
        assert_eq!(
            roots[0],
            RootSpec {
                path: t.root.clone(),
                saved: true,
                library: false
            }
        );
        assert!(!roots[1].saved && !roots[1].library);
        assert!(roots[2].library);
        // The library is readable.
        assert!(ensure_within(&t.base.join("outside").join(".env"), &inner.read_scopes()).is_ok());
    }
}
