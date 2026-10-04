//! The IPC surface. Every path from the webview goes through `state::ensure_within` before any
//! file access, including native actions (reveal, drag-out, file clipboard).
//!
//! All commands are `async` so Tauri runs them off the main thread. None holds the state lock
//! across an `.await` or a dialog: they copy what they need out of it first.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::envfile::{self, LineEnding, Parsed};
use crate::error::{Error, Result};
use crate::fsops::{self, CopyOutcome, OnConflict};
use crate::manifest::{self, Manifest, Settings, SettingsUpdate};
use crate::scan::{self, FileKind, ScanResult};
use crate::state::{AppState, Inner, ensure_within};

// ---------------------------------------------------------------------------------------------
// Manifest and folders

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderView {
    pub path: PathBuf,
    pub display: String,
    /// Saved in the manifest (false for "this session only" folders).
    pub saved: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestView {
    pub config_path: PathBuf,
    pub config_display: String,
    pub home: Option<PathBuf>,
    pub roots: Vec<FolderView>,
    pub library: Option<FolderView>,
    pub settings: Settings,
    pub warnings: Vec<String>,
    /// Set when the config file couldn't be read or parsed; it is never saved over meanwhile.
    pub error: Option<String>,
}

fn manifest_view(inner: &Inner) -> ManifestView {
    let home = inner.home.as_deref();
    let (settings, warnings) = inner.manifest.settings();
    let folder = |path: PathBuf, saved| FolderView {
        display: manifest::contract(&path, home),
        path,
        saved,
    };
    let roots = inner
        .manifest
        .root_paths(home)
        .into_iter()
        .map(|p| folder(p, true))
        .chain(inner.session_roots.iter().map(|p| folder(p.clone(), false)))
        .collect();
    ManifestView {
        config_display: manifest::contract(&inner.config_path, home),
        config_path: inner.config_path.clone(),
        home: inner.home.clone(),
        roots,
        library: inner.manifest.library_path(home).map(|p| folder(p, true)),
        settings,
        warnings,
        error: inner.manifest_error.clone(),
    }
}

/// Applies `change` to a copy of the manifest and saves it; memory is only updated if the save
/// succeeds. Refuses while the file on disk couldn't be parsed, so it is never clobbered.
fn update_manifest(
    inner: &mut Inner,
    change: impl FnOnce(&mut Manifest, Option<&Path>),
) -> Result<()> {
    if let Some(err) = &inner.manifest_error {
        return Err(Error::Manifest(format!(
            "{err}. Fix or delete {} and choose Reload.",
            manifest::contract(&inner.config_path, inner.home.as_deref())
        )));
    }
    let mut next = inner.manifest.clone();
    change(&mut next, inner.home.as_deref());
    manifest::save(&inner.config_path, &next)?;
    inner.manifest = next;
    Ok(())
}

/// Loads the manifest from disk into a fresh session state (startup and Reload).
pub fn load_state(inner: &mut Inner) {
    inner.home = manifest::home();
    match manifest::config_path() {
        Ok(path) => {
            inner.config_path = path;
            match manifest::load(&inner.config_path) {
                Ok(m) => {
                    inner.manifest = m;
                    inner.manifest_error = None;
                }
                Err(e) => {
                    inner.manifest = Manifest::default();
                    inner.manifest_error = Some(e.to_string());
                }
            }
        }
        Err(e) => inner.manifest_error = Some(e.to_string()),
    }
}

#[tauri::command]
pub async fn get_manifest(state: State<'_, AppState>) -> Result<ManifestView> {
    Ok(manifest_view(&state.lock()))
}

#[tauri::command]
pub async fn reload_manifest(state: State<'_, AppState>) -> Result<ManifestView> {
    let mut inner = state.lock();
    load_state(&mut inner);
    // TODO(M8): watch::restart
    Ok(manifest_view(&inner))
}

/// Saves non-scope settings only. `roots` and `library` aren't accepted here (see
/// [`SettingsUpdate`]), so the page can't grant itself access to more folders.
#[tauri::command]
pub async fn save_manifest(
    state: State<'_, AppState>,
    settings: SettingsUpdate,
) -> Result<ManifestView> {
    let mut inner = state.lock();
    update_manifest(&mut inner, |m, _| m.apply(settings))?;
    // TODO(M8): watch::restart (include/exclude affect the watcher's filter)
    Ok(manifest_view(&inner))
}

/// Shows a native folder picker. Runs on a blocking thread with no lock held.
async fn pick_folder(
    app: &AppHandle,
    window: &WebviewWindow,
    title: &str,
) -> Result<Option<PathBuf>> {
    let mut dialog = app.dialog().file().set_title(title).set_parent(window);
    if let Some(home) = manifest::home() {
        dialog = dialog.set_directory(home);
    }
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_folder())
        .await
        .map_err(|e| Error::Native(e.to_string()))?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|e| Error::Native(e.to_string()))?;
    let path = dunce::canonicalize(&path).map_err(|e| Error::io(&path, e))?;
    Ok(Some(path))
}

/// Picks a folder to scan. `persist` saves it to the manifest; otherwise it is scanned for
/// this session only and nothing is written.
#[tauri::command]
pub async fn add_folder(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    persist: bool,
) -> Result<Option<PathBuf>> {
    let Some(path) = pick_folder(&app, &window, "Add folder").await? else {
        return Ok(None);
    };
    {
        let mut inner = state.lock();
        if persist {
            update_manifest(&mut inner, |m, home| {
                m.add_root(&path, home);
            })?;
            inner
                .session_roots
                .retain(|r| !manifest::same_path(r, &path));
        } else {
            inner.add_session_root(path.clone());
        }
    }
    // TODO(M8): watch::restart
    Ok(Some(path))
}

/// Promotes a session folder to a saved one.
#[tauri::command]
pub async fn save_folder(state: State<'_, AppState>, path: PathBuf) -> Result<()> {
    let mut inner = state.lock();
    let Some(i) = inner
        .session_roots
        .iter()
        .position(|r| manifest::same_path(r, &path))
    else {
        return Err(Error::OutOfScope(path));
    };
    let root = inner.session_roots[i].clone();
    update_manifest(&mut inner, |m, home| {
        m.add_root(&root, home);
    })?;
    inner.session_roots.remove(i);
    Ok(())
}

/// Removes a saved folder (saving the manifest), a session folder, or the library.
#[tauri::command]
pub async fn remove_folder(state: State<'_, AppState>, path: PathBuf) -> Result<()> {
    {
        let mut inner = state.lock();
        let home = inner.home.clone();
        let saved = inner
            .manifest
            .root_paths(home.as_deref())
            .iter()
            .any(|r| manifest::same_path(r, &path));
        let is_library = inner
            .manifest
            .library_path(home.as_deref())
            .is_some_and(|l| manifest::same_path(&l, &path));
        if saved {
            update_manifest(&mut inner, |m, home| {
                m.remove_root(&path, home);
            })?;
        } else if is_library {
            update_manifest(&mut inner, |m, _| m.library = None)?;
        } else {
            inner
                .session_roots
                .retain(|r| !manifest::same_path(r, &path));
        }
    }
    // TODO(M8): watch::restart
    Ok(())
}

#[tauri::command]
pub async fn set_library(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Option<PathBuf>> {
    let Some(path) = pick_folder(&app, &window, "Choose library folder").await? else {
        return Ok(None);
    };
    {
        let mut inner = state.lock();
        update_manifest(&mut inner, |m, home| m.set_library(&path, home))?;
    }
    // TODO(M8): watch::restart
    Ok(Some(path))
}

// ---------------------------------------------------------------------------------------------
// Scanning and reading

#[tauri::command]
pub async fn scan(state: State<'_, AppState>) -> Result<ScanResult> {
    let (roots, settings, home) = {
        let inner = state.lock();
        (inner.scan_roots(), inner.settings(), inner.home.clone())
    };
    tauri::async_runtime::spawn_blocking(move || scan::scan(&roots, &settings, home.as_deref()))
        .await
        .map_err(|e| Error::Native(e.to_string()))
}

/// Resolves `path` against the read scopes and returns it with the size cap.
fn readable(state: &AppState, path: &Path) -> Result<(PathBuf, u64)> {
    let inner = state.lock();
    let resolved = ensure_within(path, &inner.read_scopes())?;
    Ok((resolved, inner.settings().max_file_bytes))
}

/// Resolves `path` against the write scopes and returns it with the size cap.
fn writable(state: &AppState, path: &Path) -> Result<(PathBuf, u64)> {
    let inner = state.lock();
    let resolved = ensure_within(path, &inner.write_scopes())?;
    Ok((resolved, inner.settings().max_file_bytes))
}

fn name_of(path: &Path) -> Result<String> {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| Error::InvalidName(path.display().to_string()))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigContent {
    pub path: PathBuf,
    pub name: String,
    pub kind: FileKind,
    pub text: String,
    pub line_ending: LineEnding,
    pub has_bom: bool,
    pub modified_ms: u64,
    pub size: u64,
    /// Parsed lines for dotenv files.
    pub env: Option<Parsed>,
}

#[tauri::command]
pub async fn read_config(state: State<'_, AppState>, path: PathBuf) -> Result<ConfigContent> {
    let (path, max) = readable(&state, &path)?;
    let file = fsops::read_text(&path, max)?;
    let name = name_of(&path)?;
    let env = envfile::is_dotenv_name(&name).then(|| envfile::parse(&file.text));
    Ok(ConfigContent {
        kind: scan::kind_of(&name),
        line_ending: LineEnding::detect(&file.text),
        name,
        path,
        text: file.text,
        has_bom: file.had_bom,
        modified_ms: file.modified_ms,
        size: file.size,
        env,
    })
}

// ---------------------------------------------------------------------------------------------
// Writing

/// Saves edited text if the file hasn't changed since it was loaded. Returns the new mtime.
#[tauri::command]
pub async fn write_config(
    state: State<'_, AppState>,
    path: PathBuf,
    content: String,
    expected_modified_ms: u64,
) -> Result<u64> {
    let (path, _) = writable(&state, &path)?;
    fsops::write_checked(&path, &content, expected_modified_ms)
}

#[derive(Debug, Clone, Deserialize)]
pub struct EnvVar {
    pub key: String,
    pub value: String,
}

/// Upserts variables into a dotenv file, keeping its comments, order and line endings.
#[tauri::command]
pub async fn set_env_vars(
    state: State<'_, AppState>,
    path: PathBuf,
    vars: Vec<EnvVar>,
) -> Result<u64> {
    if let Some(bad) = vars.iter().find(|v| !envfile::is_valid_key(&v.key)) {
        return Err(Error::InvalidDotenv(format!(
            "\"{}\" isn't a valid variable name",
            bad.key
        )));
    }
    let (path, max) = writable(&state, &path)?;
    let vars: Vec<(String, String)> = vars.into_iter().map(|v| (v.key, v.value)).collect();
    fsops::set_env_vars(&path, &vars, max)
}

/// Picks a destination folder in a native dialog and grants writes to it for this session.
#[tauri::command]
pub async fn pick_destination(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Option<PathBuf>> {
    let Some(path) = pick_folder(&app, &window, "Copy to folder").await? else {
        return Ok(None);
    };
    state.lock().grant_destination(path.clone());
    Ok(Some(path))
}

#[tauri::command]
pub async fn copy_config(
    state: State<'_, AppState>,
    src: PathBuf,
    dest_dir: PathBuf,
    on_conflict: Option<OnConflict>,
    file_name: Option<String>,
) -> Result<CopyOutcome> {
    let (src, max) = readable(&state, &src)?;
    let (dest_dir, _) = writable(&state, &dest_dir)?;
    if !dest_dir.is_dir() {
        return Err(Error::NotFound(dest_dir));
    }
    let file_name = match file_name {
        Some(n) => n,
        None => name_of(&src)?,
    };
    fsops::copy(
        &src,
        &dest_dir,
        &file_name,
        on_conflict.unwrap_or_default(),
        max,
    )
}

/// `.env.example` -> `.env` next to it. Never overwrites.
#[tauri::command]
pub async fn create_from_template(state: State<'_, AppState>, path: PathBuf) -> Result<PathBuf> {
    let (src, max) = readable(&state, &path)?;
    let name = name_of(&src)?;
    let target = envfile::template_target(&name)
        .ok_or_else(|| Error::InvalidDotenv(format!("{name} isn't a dotenv template")))?;
    let dir = src
        .parent()
        .ok_or_else(|| Error::NotFound(src.clone()))?
        .to_path_buf();
    writable(&state, &dir)?;
    Ok(fsops::copy(&src, &dir, &target, OnConflict::Fail, max)?.path)
}

// ---------------------------------------------------------------------------------------------
// Native actions

/// Runs `f` on the main thread (required by the macOS pasteboard and drag APIs) and waits for
/// its result without blocking an async worker.
async fn on_main_thread<T: Send + 'static>(
    app: &AppHandle,
    f: impl FnOnce() -> T + Send + 'static,
) -> Result<T> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|e| Error::Native(e.to_string()))?;
    tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|e| Error::Native(e.to_string()))?
        .map_err(|e| Error::Native(e.to_string()))
}

/// Puts the files themselves on the OS clipboard (paste into Finder, Explorer, VS Code).
#[tauri::command]
pub async fn copy_files_to_clipboard(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<PathBuf>,
) -> Result<()> {
    let files = paths
        .iter()
        .map(|p| readable(&state, p).map(|(p, _)| p.to_string_lossy().into_owned()))
        .collect::<Result<Vec<_>>>()?;
    if files.is_empty() {
        return Ok(());
    }
    on_main_thread(&app, move || {
        use clipboard_rs::{Clipboard, ClipboardContext};
        ClipboardContext::new()
            .and_then(|ctx| ctx.set_files(files))
            .map_err(|e| Error::Native(format!("Couldn't copy the file: {e}")))
    })
    .await?
}

/// Shows the file in Finder / Explorer.
#[tauri::command]
pub async fn reveal(state: State<'_, AppState>, path: PathBuf) -> Result<()> {
    let (path, _) = readable(&state, &path)?;
    tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|e| Error::Native(e.to_string()))
}

const DRAG_ICON: &[u8] = include_bytes!("../icons/32x32.png");

/// Starts a native drag of the file out of the window (drop into Finder, Explorer, VS Code).
/// Call it from a pointer-down/drag-start handler.
#[tauri::command]
pub async fn start_drag(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    path: PathBuf,
) -> Result<()> {
    let (path, _) = readable(&state, &path)?;
    // Don't wait for the result: on Windows the drag loop runs until the drop.
    app.run_on_main_thread(move || {
        let _ = drag::start_drag(
            &window,
            drag::DragItem::Files(vec![path]),
            drag::Image::Raw(DRAG_ICON.to_vec()),
            |_result, _cursor| {},
            drag::Options::default(),
        );
    })
    .map_err(|e| Error::Native(e.to_string()))
}

/// Registers state and loads the manifest. Called from `lib.rs` setup.
pub fn init_state(app: &AppHandle) {
    let mut inner = Inner::default();
    load_state(&mut inner);
    app.manage(AppState::new(inner));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inner_with(dir: &Path, manifest_json: Option<&str>) -> Inner {
        let config_path = dir.join(manifest::FILE_NAME);
        let mut inner = Inner {
            config_path: config_path.clone(),
            home: Some(dir.to_path_buf()),
            ..Default::default()
        };
        if let Some(json) = manifest_json {
            std::fs::write(&config_path, json).unwrap();
        }
        match manifest::load(&config_path) {
            Ok(m) => inner.manifest = m,
            Err(e) => inner.manifest_error = Some(e.to_string()),
        }
        inner
    }

    #[test]
    fn update_manifest_saves_and_applies() {
        let dir = tempfile::tempdir().unwrap();
        let mut inner = inner_with(dir.path(), None);
        let code = dir.path().join("code");
        update_manifest(&mut inner, |m, home| {
            m.add_root(&code, home);
        })
        .unwrap();
        assert_eq!(
            inner.manifest.roots.as_deref(),
            Some(&["~/code".to_string()][..])
        );
        let on_disk = std::fs::read_to_string(&inner.config_path).unwrap();
        assert!(on_disk.contains("\"~/code\""), "{on_disk}");
    }

    #[test]
    fn update_manifest_refuses_to_overwrite_a_broken_file() {
        let dir = tempfile::tempdir().unwrap();
        let mut inner = inner_with(dir.path(), Some("{ broken"));
        let err = update_manifest(&mut inner, |m, _| m.max_depth = Some(2)).unwrap_err();
        assert!(matches!(err, Error::Manifest(_)));
        assert_eq!(
            std::fs::read_to_string(&inner.config_path).unwrap(),
            "{ broken"
        );
        assert_eq!(inner.manifest.max_depth, None);
    }

    #[test]
    fn manifest_view_lists_saved_then_session_roots() {
        let dir = tempfile::tempdir().unwrap();
        let mut inner = inner_with(
            dir.path(),
            Some(r#"{ "roots": ["~/code"], "library": "~/lib", "editor": "nope" }"#),
        );
        inner.add_session_root(dir.path().join("tmp"));
        let view = manifest_view(&inner);
        assert_eq!(view.roots.len(), 2);
        assert!(view.roots[0].saved && !view.roots[1].saved);
        assert_eq!(view.roots[0].display, "~/code");
        assert_eq!(view.library.unwrap().display, "~/lib");
        assert_eq!(view.warnings.len(), 1);
        assert_eq!(view.config_display, "~/.envdeck.json");
        let json = serde_json::to_value(manifest_view(&inner)).unwrap();
        assert_eq!(json["settings"]["editor"], "vscode");
        assert!(json["settings"]["excludeDirs"].is_array());
    }
}
