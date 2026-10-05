//! Debounced recursive watcher that emits `configs-changed` to the webview.
//!
//! One watcher per root (FSEvents on macOS, ReadDirectoryChangesW on Windows), debounced at
//! 400 ms. Events inside excluded dirs and EnvDeck's own temp files are dropped. Paths matching
//! an include glob, and any remove/rename (which can take configs with it), are emitted. An empty
//! `paths` list means "something changed, rescan everything" (e.g. a watcher overflow).

use std::path::{Path, PathBuf};
use std::time::Duration;

use notify_debouncer_full::notify::{
    Config, EventKind, RecommendedWatcher, RecursiveMode, event::ModifyKind,
};
use notify_debouncer_full::{
    DebounceEventResult, DebouncedEvent, Debouncer, NoCache, new_debouncer_opt,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::manifest::Settings;
use crate::scan::Matcher;
use crate::state::{AppState, RootSpec};

pub const EVENT: &str = "configs-changed";
const DEBOUNCE: Duration = Duration::from_millis(400);
const TEMP_SUFFIX: &str = ".envdeck-tmp";

/// No file-ID cache: `RecommendedCache` walks and remembers every file under each root (including
/// `node_modules`), which costs hundreds of MB on large roots. EnvDeck treats renames as "rescan"
/// anyway, so it doesn't need the cache's rename matching.
type Watcher = Debouncer<RecommendedWatcher, NoCache>;

/// Running watchers. Dropping it stops them.
pub struct WatchHandle {
    _debouncers: Vec<Watcher>,
    /// Roots that are actually watched (missing ones are skipped).
    pub watched: Vec<PathBuf>,
}

impl std::fmt::Debug for WatchHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WatchHandle")
            .field("watched", &self.watched)
            .finish()
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ConfigsChanged {
    /// Changed paths; empty means "rescan everything".
    pub paths: Vec<PathBuf>,
}

/// Is a change to `path` worth telling the UI about?
fn relevant(path: &Path, kind: &EventKind, roots: &[PathBuf], matcher: &Matcher) -> bool {
    if path
        .file_name()
        .is_some_and(|n| n.to_string_lossy().ends_with(TEMP_SUFFIX))
    {
        return false;
    }
    let Some(rel) = roots.iter().find_map(|r| path.strip_prefix(r).ok()) else {
        return false;
    };
    if matcher.in_excluded_dir(rel) || rel.as_os_str().is_empty() {
        return false;
    }
    let removed_or_renamed = matches!(
        kind,
        EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_))
    );
    removed_or_renamed || matcher.is_included(rel)
}

/// Reduces a debounced batch to the paths to emit; `Some(vec![])` asks for a full rescan.
fn filter_batch(
    events: &[DebouncedEvent],
    roots: &[PathBuf],
    matcher: &Matcher,
) -> Option<Vec<PathBuf>> {
    if events.iter().any(|e| e.need_rescan()) {
        return Some(Vec::new());
    }
    let mut paths: Vec<PathBuf> = Vec::new();
    for e in events {
        for p in &e.paths {
            if relevant(p, &e.kind, roots, matcher) && !paths.contains(p) {
                paths.push(p.clone());
            }
        }
    }
    (!paths.is_empty()).then_some(paths)
}

/// Starts one debounced watcher per existing root; `sink` gets each relevant batch.
pub fn start(
    roots: &[RootSpec],
    settings: &Settings,
    sink: impl Fn(Vec<PathBuf>) + Send + Sync + Clone + 'static,
) -> WatchHandle {
    let (matcher, _) = Matcher::new(settings);
    let matcher = std::sync::Arc::new(matcher);
    let mut debouncers = Vec::new();
    let mut watched = Vec::new();

    for spec in roots {
        let Ok(root) = dunce::canonicalize(&spec.path) else {
            continue; // Missing roots are reported by the scan; nothing to watch.
        };
        if !root.is_dir() || watched.contains(&root) {
            continue;
        }
        let matcher = matcher.clone();
        let sink = sink.clone();
        let roots_for_filter = vec![root.clone()];
        let handler = move |result: DebounceEventResult| match result {
            Ok(events) => {
                if let Some(paths) = filter_batch(&events, &roots_for_filter, &matcher) {
                    sink(paths);
                }
            }
            // Watcher errors (e.g. buffer overflow): ask for a full rescan.
            Err(_) => sink(Vec::new()),
        };
        let Ok(mut debouncer) = new_debouncer_opt::<_, RecommendedWatcher, NoCache>(
            DEBOUNCE,
            None,
            handler,
            NoCache,
            Config::default(),
        ) else {
            continue;
        };
        if debouncer.watch(&root, RecursiveMode::Recursive).is_ok() {
            debouncers.push(debouncer);
            watched.push(root);
        }
    }

    WatchHandle {
        _debouncers: debouncers,
        watched,
    }
}

/// (Re)starts watching the current roots and library, replacing any previous watcher. Call it
/// whenever roots, the library or the include/exclude settings change.
pub fn restart(app: &AppHandle) {
    let state = app.state::<AppState>();
    let (roots, settings) = {
        let inner = state.lock();
        (inner.scan_roots(), inner.settings())
    };
    // Stop the old watchers first so they don't emit during the swap.
    drop(state.lock().watcher.take());

    let emitter = app.clone();
    let handle = start(&roots, &settings, move |paths| {
        let _ = emitter.emit(EVENT, ConfigsChanged { paths });
    });
    state.lock().watcher = Some(handle);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::Manifest;
    use notify_debouncer_full::notify::event::{CreateKind, DataChange, RemoveKind, RenameMode};
    use std::sync::mpsc;
    use std::time::Instant;

    fn settings() -> Settings {
        Manifest::default().settings().0
    }

    fn matcher() -> Matcher {
        Matcher::new(&settings()).0
    }

    fn root() -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(r"C:\code")
        } else {
            PathBuf::from("/code")
        }
    }

    fn at(rel: &str) -> PathBuf {
        rel.split('/').fold(root(), |p, c| p.join(c))
    }

    #[test]
    fn filter_keeps_configs_and_drops_noise() {
        let m = matcher();
        let roots = vec![root()];
        let modify = EventKind::Modify(ModifyKind::Data(DataChange::Content));
        let create = EventKind::Create(CreateKind::File);
        let remove = EventKind::Remove(RemoveKind::Any);
        let rename = EventKind::Modify(ModifyKind::Name(RenameMode::Any));

        assert!(relevant(&at("api/.env"), &modify, &roots, &m));
        assert!(relevant(
            &at("api/.vscode/launch.json"),
            &create,
            &roots,
            &m
        ));
        // Not a config: ignored unless removed/renamed (a folder may have taken configs with it).
        assert!(!relevant(&at("api/src/main.rs"), &modify, &roots, &m));
        assert!(relevant(&at("api/old-folder"), &remove, &roots, &m));
        assert!(relevant(&at("api/old-folder"), &rename, &roots, &m));
        // Excluded dirs, temp files, the root itself and other roots are dropped.
        assert!(!relevant(
            &at("web/node_modules/pkg/.env"),
            &modify,
            &roots,
            &m
        ));
        assert!(!relevant(&at("web/node_modules/pkg"), &remove, &roots, &m));
        assert!(!relevant(&at("api/..env.envdeck-tmp"), &create, &roots, &m));
        assert!(!relevant(&root(), &modify, &roots, &m));
        assert!(!relevant(Path::new("/elsewhere/.env"), &modify, &roots, &m));
    }

    fn wait_for(rx: &mpsc::Receiver<Vec<PathBuf>>, want: &Path, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while let Some(left) = deadline.checked_duration_since(Instant::now()) {
            match rx.recv_timeout(left) {
                Ok(paths) if paths.is_empty() || paths.iter().any(|p| p == want) => return true,
                Ok(_) => continue,
                Err(_) => return false,
            }
        }
        false
    }

    /// Real watcher on a temp folder: a config change is reported, a change in an excluded dir
    /// isn't. Timing-based, so it waits generously.
    #[test]
    fn watches_a_real_folder() {
        let dir = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(dir.path()).unwrap();
        std::fs::create_dir_all(base.join("app").join("node_modules").join("pkg")).unwrap();
        let (tx, rx) = mpsc::channel::<Vec<PathBuf>>();
        let tx = std::sync::Arc::new(std::sync::Mutex::new(tx));
        let spec = RootSpec {
            path: base.clone(),
            saved: true,
            library: false,
        };
        let missing = RootSpec {
            path: base.join("gone"),
            saved: true,
            library: false,
        };
        let handle = start(&[spec, missing], &settings(), move |paths| {
            let _ = tx.lock().unwrap().send(paths);
        });
        assert_eq!(handle.watched, vec![base.clone()]);
        std::thread::sleep(Duration::from_millis(200));

        // Noise first, so a later batch can't be mistaken for it.
        std::fs::write(
            base.join("app")
                .join("node_modules")
                .join("pkg")
                .join(".env"),
            "X=1",
        )
        .unwrap();
        std::fs::write(base.join("app").join("main.rs"), "fn main() {}").unwrap();
        std::thread::sleep(Duration::from_millis(900));
        let noise: Vec<Vec<PathBuf>> = rx.try_iter().collect();
        assert!(
            noise.iter().all(|batch| !batch.is_empty()
                && batch
                    .iter()
                    .all(|p| !p.to_string_lossy().contains("node_modules"))),
            "unexpected events: {noise:?}"
        );

        let env = base.join("app").join(".env");
        std::fs::write(&env, "A=1\n").unwrap();
        assert!(
            wait_for(&rx, &env, Duration::from_secs(5)),
            "no event for {}",
            env.display()
        );
        drop(handle);
    }
}
