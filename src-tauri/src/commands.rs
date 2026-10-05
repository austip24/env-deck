//! The IPC surface. Every path from the webview goes through `state::ensure_within` before any
//! file access, including native actions (reveal, drag-out, file clipboard) and the GitHub push.
//!
//! All commands are `async` so Tauri runs them off the main thread. None holds the state lock
//! across an `.await` or a dialog: they copy what they need out of it first.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::envfile::{self, LineEnding, Parsed};
use crate::error::{Error, Result};
use crate::fsops::{self, CopyOutcome, OnConflict};
use crate::github;
use crate::github_auth::{self, Poll, Token, TokenState};
use crate::manifest::{self, Manifest, Settings, SettingsUpdate};
use crate::scan::{self, FileKind, ScanResult};
use crate::state::{AppState, Inner, ensure_within};
use crate::watch;

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
pub async fn reload_manifest(app: AppHandle, state: State<'_, AppState>) -> Result<ManifestView> {
    load_state(&mut state.lock());
    watch::restart(&app);
    Ok(manifest_view(&state.lock()))
}

/// Saves non-scope settings only. `roots` and `library` aren't accepted here (see
/// [`SettingsUpdate`]), so the page can't grant itself access to more folders.
#[tauri::command]
pub async fn save_manifest(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: SettingsUpdate,
) -> Result<ManifestView> {
    update_manifest(&mut state.lock(), |m, _| m.apply(settings))?;
    // include/exclude feed the watcher's filter.
    watch::restart(&app);
    Ok(manifest_view(&state.lock()))
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
    watch::restart(&app);
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
pub async fn remove_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    path: PathBuf,
) -> Result<()> {
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
    watch::restart(&app);
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
    watch::restart(&app);
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

// ---------------------------------------------------------------------------------------------
// GitHub: sign-in to the EnvDeck GitHub App with the Device Flow (github_auth.rs); pushes run
// `gh` with that token (github.rs). The token never leaves Rust.

/// The folder holding a dotenv file, after the scope check.
fn dotenv_dir(state: &AppState, path: &Path) -> Result<(PathBuf, PathBuf, u64)> {
    let (path, max) = readable(state, path)?;
    if !envfile::is_dotenv_name(&name_of(&path)?) {
        return Err(Error::NotDotenv(path));
    }
    let dir = path
        .parent()
        .ok_or_else(|| Error::NotFound(path.clone()))?
        .to_path_buf();
    Ok((path, dir, max))
}

/// Resolves a remote name against the repository next to the file, so the webview can't point
/// `gh` at an arbitrary repository.
fn github_remote(dir: &Path, max: u64, remote: &str) -> Result<github::Remote> {
    github::detect_repo(dir, max)?
        .remotes
        .into_iter()
        .find(|r| r.remote == remote)
        .ok_or_else(|| Error::NoRepo(format!("No GitHub remote named {remote}")))
}

const SIGN_IN: &str = "Sign in to GitHub to continue.";
const EXPIRED: &str = "Your GitHub sign-in expired. Sign in again.";

/// The session's token for a github.com remote (the GitHub App lives on github.com). An expired
/// token is refreshed first (8-hour tokens; the refresh happens outside the lock).
async fn github_token(state: &AppState, repo: &github::Remote) -> Result<Token> {
    if repo.host != "github.com" {
        return Err(Error::Gh(format!(
            "Sign-in with GitHub covers github.com repositories; this remote is on {}",
            repo.host
        )));
    }
    let (token_state, generation) = {
        let mut inner = state.lock();
        let session = &mut inner.github;
        match session.token_state(Instant::now()) {
            TokenState::SignedOut if session.token.is_some() => {
                session.sign_out();
                return Err(Error::GhAuth(EXPIRED.into()));
            }
            s => (s, session.generation),
        }
    };
    match token_state {
        TokenState::Valid(token) => Ok(token),
        TokenState::SignedOut => Err(Error::GhAuth(SIGN_IN.into())),
        TokenState::NeedsRefresh(refresh) => {
            let client_id = github_auth::client_id()?;
            let poll = tauri::async_runtime::spawn_blocking(move || {
                github_auth::refresh(client_id, &refresh)
            })
            .await
            .map_err(|e| Error::Native(e.to_string()))?;
            apply_refresh(state, generation, poll, Instant::now())
        }
    }
}

/// Stores a refreshed grant, unless the user signed out meanwhile. A refused refresh signs out;
/// a network error keeps the session so the next attempt can retry.
fn apply_refresh(
    state: &AppState,
    generation: u64,
    poll: Result<Poll>,
    now: Instant,
) -> Result<Token> {
    let mut inner = state.lock();
    if inner.github.generation != generation {
        return Err(Error::GhAuth(SIGN_IN.into()));
    }
    match poll? {
        Poll::Done(grant) => {
            let token = grant.access.clone();
            inner.github.store(grant, now);
            Ok(token)
        }
        _ => {
            inner.github.sign_out();
            Err(Error::GhAuth(EXPIRED.into()))
        }
    }
}

/// Forgets a token GitHub rejected, so the UI offers "Sign in" again.
fn forget_rejected<T>(state: &AppState, token: &Token, result: Result<T>) -> Result<T> {
    if let Err(Error::GhAuth(_)) = &result {
        let mut inner = state.lock();
        if inner.github.token.as_ref() == Some(token) {
            inner.github.sign_out();
        }
    }
    result
}

/// GitHub remotes of the repository whose `.git` sits next to the dotenv file. Reads files only.
#[tauri::command]
pub async fn github_repo(state: State<'_, AppState>, path: PathBuf) -> Result<github::RepoInfo> {
    let (_, dir, max) = dotenv_dir(&state, &path)?;
    github::detect_repo(&dir, max)
}

/// Environments and the names of existing secrets/variables (never values).
#[tauri::command]
pub async fn github_inspect(
    state: State<'_, AppState>,
    path: PathBuf,
    remote: String,
) -> Result<github::GithubState> {
    let (_, dir, max) = dotenv_dir(&state, &path)?;
    let repo = github_remote(&dir, max, &remote)?;
    let token = github_token(&state, &repo).await?;
    let t = token.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        github::inspect(&github::GhCli::locate(t)?, &repo)
    })
    .await
    .map_err(|e| Error::Native(e.to_string()))?;
    forget_rejected(&state, &token, result)
}

/// Sets secrets/variables from the file's current values, which Rust reads itself: values never
/// cross IPC, and only keys that are in the file can be pushed.
#[tauri::command]
pub async fn github_push(
    state: State<'_, AppState>,
    path: PathBuf,
    remote: String,
    items: Vec<github::PushItem>,
) -> Result<Vec<github::PushResult>> {
    let (path, dir, max) = dotenv_dir(&state, &path)?;
    let repo = github_remote(&dir, max, &remote)?;
    let token = github_token(&state, &repo).await?;
    let vars = envfile::parse(&fsops::read_text(&path, max)?.text).vars();
    let t = token.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        github::push(&github::GhCli::locate(t)?, &repo, &vars, &items)
    })
    .await
    .map_err(|e| Error::Native(e.to_string()))?;
    forget_rejected(&state, &token, result)
}

/// A GitHub page for the repository next to the file, built in Rust: `install` (the EnvDeck
/// GitHub App's install page) or `environments` (the repository's environment settings).
fn github_page_url(repo: &github::Remote, page: &str) -> Result<String> {
    match page {
        "install" => Ok(github_auth::install_url(github_auth::app_slug()?)),
        "environments" => Ok(format!(
            "https://{}/{}/{}/settings/environments",
            repo.host, repo.owner, repo.name
        )),
        _ => Err(Error::Native(format!("Unknown GitHub page \"{page}\""))),
    }
}

/// Opens a GitHub page in the browser. The URL is built in Rust from the detected remote; the
/// webview only names the page.
#[tauri::command]
pub async fn github_open_page(
    state: State<'_, AppState>,
    path: PathBuf,
    remote: String,
    page: String,
) -> Result<()> {
    let (_, dir, max) = dotenv_dir(&state, &path)?;
    let repo = github_remote(&dir, max, &remote)?;
    tauri_plugin_opener::open_url(github_page_url(&repo, &page)?, None::<&str>)
        .map_err(|e| Error::Native(e.to_string()))
}

/// Whether sign-in is available in this build, and who is signed in.
#[tauri::command]
pub async fn github_account(state: State<'_, AppState>) -> Result<github_auth::Account> {
    Ok(github_auth::account(&state.lock().github))
}

fn open_verification() -> Result<()> {
    tauri_plugin_opener::open_url(github_auth::VERIFY_URL, None::<&str>)
        .map_err(|e| Error::Native(e.to_string()))
}

/// Starts the Device Flow: returns the code to type and opens github.com/login/device.
#[tauri::command]
pub async fn github_sign_in_start(state: State<'_, AppState>) -> Result<github_auth::DeviceLogin> {
    let client_id = github_auth::client_id()?;
    let (login, device_code, interval) =
        tauri::async_runtime::spawn_blocking(move || github_auth::request_device_code(client_id))
            .await
            .map_err(|e| Error::Native(e.to_string()))??;
    {
        let mut inner = state.lock();
        let session = &mut inner.github;
        session.generation += 1;
        session.flow = Some(github_auth::Flow {
            device_code,
            interval_secs: interval,
            expires_in_secs: login.expires_in,
            generation: session.generation,
        });
    }
    // The dialog shows the code and a button to open the page again if this fails.
    let _ = open_verification();
    Ok(login)
}

/// Opens github.com/login/device again (a fixed URL; nothing from the webview).
#[tauri::command]
pub async fn github_open_verification() -> Result<()> {
    open_verification()
}

/// Waits until the user approves the code on GitHub, it expires, or sign-in is cancelled.
#[tauri::command]
pub async fn github_sign_in_wait(app: AppHandle) -> Result<github_auth::Account> {
    tauri::async_runtime::spawn_blocking(move || wait_for_sign_in(&app.state::<AppState>()))
        .await
        .map_err(|e| Error::Native(e.to_string()))?
}

fn wait_for_sign_in(state: &AppState) -> Result<github_auth::Account> {
    let client_id = github_auth::client_id()?;
    let flow = state
        .lock()
        .github
        .flow
        .clone()
        .ok_or_else(|| Error::GhAuth("No sign-in in progress.".into()))?;
    let current = || state.lock().github.generation == flow.generation;
    let fail = |msg: &str| {
        let mut inner = state.lock();
        if inner.github.generation == flow.generation {
            inner.github.flow = None;
        }
        Error::GhAuth(msg.into())
    };
    let deadline = Instant::now() + Duration::from_secs(flow.expires_in_secs);
    let mut interval = flow.interval_secs.max(1);
    loop {
        // Sleep in short steps so Cancel (sign-out) takes effect quickly.
        let wake = Instant::now() + Duration::from_secs(interval);
        while Instant::now() < wake {
            if !current() {
                return Err(Error::GhAuth("Sign-in cancelled.".into()));
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        if Instant::now() >= deadline {
            return Err(fail("The sign-in code expired. Start again."));
        }
        match github_auth::poll_token(client_id, &flow.device_code, interval)? {
            Poll::Pending => {}
            Poll::SlowDown(next) => interval = next,
            Poll::Failed(msg) => return Err(fail(&msg)),
            Poll::Done(grant) => {
                let login = github_auth::fetch_login(&grant.access)?;
                let mut inner = state.lock();
                if inner.github.generation != flow.generation {
                    return Err(Error::GhAuth("Sign-in cancelled.".into()));
                }
                inner.github.store(grant, Instant::now());
                inner.github.login = Some(login);
                inner.github.flow = None;
                return Ok(github_auth::account(&inner.github));
            }
        }
    }
}

/// Forgets the token (memory only) and cancels a sign-in in progress.
#[tauri::command]
pub async fn github_sign_out(state: State<'_, AppState>) -> Result<github_auth::Account> {
    let mut inner = state.lock();
    inner.github.sign_out();
    Ok(github_auth::account(&inner.github))
}

/// Registers state and loads the manifest. Called from `lib.rs` setup.
pub fn init_state(app: &AppHandle) {
    let mut inner = Inner::default();
    load_state(&mut inner);
    app.manage(AppState::new(inner));
    watch::restart(app);
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
    fn github_commands_check_scope_and_resolve_remotes_in_rust() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("code");
        let outside = dir.path().join("elsewhere");
        for d in [&root, &outside] {
            std::fs::create_dir_all(d.join(".git")).unwrap();
            std::fs::write(
                d.join(".git/config"),
                "[remote \"origin\"]\n\turl = git@github.com:acme/shop.git\n",
            )
            .unwrap();
            std::fs::write(d.join(".env"), "A=1\n").unwrap();
            std::fs::write(d.join("app.json"), "{}").unwrap();
        }
        let mut inner = inner_with(dir.path(), None);
        inner.add_session_root(dunce::canonicalize(&root).unwrap());
        let state = AppState::new(inner);

        let (_, repo_dir, max) = dotenv_dir(&state, &root.join(".env")).unwrap();
        assert_eq!(
            github_remote(&repo_dir, max, "origin").unwrap().owner,
            "acme"
        );
        assert!(matches!(
            github_remote(&repo_dir, max, "evil"),
            Err(Error::NoRepo(_))
        ));
        assert!(matches!(
            dotenv_dir(&state, &outside.join(".env")),
            Err(Error::OutOfScope(_))
        ));
        assert!(matches!(
            dotenv_dir(&state, &root.join("../elsewhere/.env")),
            Err(Error::OutOfScope(_))
        ));
        assert!(matches!(
            dotenv_dir(&state, &root.join("app.json")),
            Err(Error::NotDotenv(_))
        ));
    }

    fn shop_remote() -> github::Remote {
        github::Remote {
            remote: "origin".into(),
            host: "github.com".into(),
            owner: "acme".into(),
            name: "shop".into(),
        }
    }

    fn grant(access: &str, expires_in: u64) -> github_auth::Grant {
        github_auth::Grant {
            access: Token::new(access),
            expires_in: Some(expires_in),
            refresh: Some(Token::new("ghr_refresh")),
            refresh_expires_in: Some(15_897_600),
        }
    }

    #[test]
    fn github_token_needs_sign_in_and_rejected_tokens_are_forgotten() {
        let token_for = |state: &AppState, repo: &github::Remote| {
            tauri::async_runtime::block_on(github_token(state, repo))
        };
        let state = AppState::default();
        let mut repo = shop_remote();
        assert!(matches!(token_for(&state, &repo), Err(Error::GhAuth(_))));

        let token = Token::new("ghu_test");
        state
            .lock()
            .github
            .store(grant("ghu_test", 28_800), Instant::now());
        state.lock().github.login = Some("octocat".into());
        assert_eq!(token_for(&state, &repo).unwrap(), token);

        repo.host = "ghe.example.com".into();
        assert!(matches!(token_for(&state, &repo), Err(Error::Gh(_))));

        let ok: Result<()> = forget_rejected(&state, &token, Err(Error::Gh("HTTP 403".into())));
        assert!(ok.is_err() && state.lock().github.token.is_some());
        let _ = forget_rejected::<()>(&state, &token, Err(Error::GhAuth("rejected".into())));
        assert!(state.lock().github.token.is_none());
        assert!(state.lock().github.login.is_none());
    }

    #[test]
    fn expired_tokens_without_a_refresh_sign_out() {
        let state = AppState::default();
        let t0 = Instant::now();
        state.lock().github.store(
            github_auth::Grant {
                refresh: None,
                refresh_expires_in: None,
                ..grant("ghu_old", 1)
            },
            t0,
        );
        state.lock().github.login = Some("octocat".into());
        let err = tauri::async_runtime::block_on(github_token(&state, &shop_remote())).unwrap_err();
        assert!(err.to_string().contains("expired"), "{err}");
        assert!(state.lock().github.login.is_none());
    }

    #[test]
    fn refreshes_are_stored_unless_signed_out_meanwhile() {
        let state = AppState::default();
        let now = Instant::now();
        let generation = state.lock().github.generation;

        let token = apply_refresh(
            &state,
            generation,
            Ok(Poll::Done(grant("ghu_new", 28_800))),
            now,
        )
        .unwrap();
        assert_eq!(token, Token::new("ghu_new"));
        assert_eq!(
            state.lock().github.token_state(now),
            TokenState::Valid(Token::new("ghu_new"))
        );

        // A network error keeps the session for a later retry.
        let err = apply_refresh(&state, generation, Err(Error::Gh("offline".into())), now);
        assert!(matches!(err, Err(Error::Gh(_))));
        assert!(state.lock().github.token.is_some());

        // GitHub refused the refresh: signed out.
        let err = apply_refresh(&state, generation, Ok(Poll::Failed("bad".into())), now);
        assert!(matches!(err, Err(Error::GhAuth(_))));
        assert!(state.lock().github.token.is_none());

        // Signed out (generation bumped) while refreshing: the new grant is dropped.
        let stale = generation + 1;
        state.lock().github.sign_out();
        let err = apply_refresh(
            &state,
            stale - 1,
            Ok(Poll::Done(grant("ghu_late", 60))),
            now,
        );
        assert!(matches!(err, Err(Error::GhAuth(_))));
        assert!(state.lock().github.token.is_none());
    }

    #[test]
    fn github_pages_are_built_in_rust() {
        let repo = shop_remote();
        assert_eq!(
            github_page_url(&repo, "environments").unwrap(),
            "https://github.com/acme/shop/settings/environments"
        );
        assert!(github_page_url(&repo, "https://evil.example").is_err());
        // The install page needs the compiled-in slug.
        assert_eq!(
            github_page_url(&repo, "install").is_ok(),
            github_auth::app_slug().is_ok()
        );
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
