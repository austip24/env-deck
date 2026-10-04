# EnvDeck: implementation plan

How to get from the current scaffold to the app described in [ARCHITECTURE.md](ARCHITECTURE.md).
ARCHITECTURE.md stays the source of truth for *what* to build; this file is the order to build
it in, the details the architecture leaves open, and the checks that close each milestone.
[AGENTS.md](AGENTS.md) rules apply throughout.

## Status

| # | Milestone | Status |
| --- | --- | --- |
| M0 | Scaffold alignment | **done** (2026-10-04) |
| M1 | Rust foundations | **done** (2026-10-04) |
| M2 | dotenv engine | **done** (2026-10-04) |
| M3 | Scanner | **done** (2026-10-04) |
| M4–M9 | | not started |

## Milestones at a glance

| # | Milestone | Depends on | Size |
| --- | --- | --- | --- |
| M0 | Scaffold alignment | – | S |
| M1 | Rust foundations: `error`, `manifest`, `state` (scope guard), `fsops` | M0 | M |
| M2 | dotenv engine: `envfile` | M0 (parallel with M1) | M |
| M3 | Scanner: `scan` | M1 | M |
| M4 | IPC surface: `commands`, `lib/ipc.ts`, `dev/mock-ipc.ts` | M1–M3 | M |
| M5 | Read-only UI: sidebar, file view, env table, source view | M4 (types only; can start on mock) | L |
| M6 | Getting configs out: clipboard, copy-as, editor, reveal, file clipboard, drag | M5 | M |
| M7 | Writes in the UI: edit/save, Copy to…, Send to, Compare, template | M5, M6 | L |
| M8 | Live updates: `watch` | M4, M5 | S |
| M9 | Hardening, packaging, CI, native smoke tests | all | M |

Every milestone ends with the AGENTS.md gate: `npm run build` (includes the mock-IPC bundle
check), `npm run lint`, `npm test`, `npm run test:rust`, clippy warning-free, `cargo fmt`.
UI milestones also get a `dev:mock` pass in light and dark themes.

---

## M0: Scaffold alignment (done)

What was done, for reference:

- `git init` on `main`; first commit is the untouched `create-tauri-app` scaffold.
  `.gitattributes` keeps the repo LF (CRLF test data is built in code, not checked in).
- `Cargo.toml`: edition 2024; crates `tauri-plugin-{opener,dialog,clipboard-manager}`, `drag`
  (CrabNebula, used from Rust per D1), `walkdir`, `globset`, `notify-debouncer-full` 0.5,
  `clipboard-rs`, `dunce`, `dirs` 6, `serde`, `serde_json`, `thiserror` 2; dev `tempfile`.
  `tauri-plugin-dialog` depends on the `tauri-plugin-fs` crate internally; it is never registered
  and has no capability, so the webview still has no file access.
- `tauri.conf.json`: `EnvDeck`, identifier `com.austi.envdeck` (D4), npm commands, 1200×780
  (min 820×520), strict CSP (`connect-src ipc: http://ipc.localhost`, no remote origins),
  bundle targets `app`, `dmg`, `nsis`, `msi`.
- `capabilities/default.json`: `core:default`, `clipboard-manager:allow-write-text`,
  `opener:allow-open-url` scoped to `vscode`/`vscode-insiders`/`cursor`/`windsurf` `://file/*`.
- npm: `radix-ui`, `lucide-react`, `sonner`, `class-variance-authority`, `clsx`,
  `tailwind-merge`, `@tauri-apps/plugin-clipboard-manager`; dev `tailwindcss`,
  `@tailwindcss/vite`, `tw-animate-css`, `oxlint`, `@types/node`, `vitest`.
- Scripts: `dev`, `dev:mock` (`vite --mode mock`), `build` (`tsc && vite build && node
  scripts/check-bundle.mjs`), `lint` (`oxlint src scripts`), `test` (`vitest run`), `test:rust`.
- `@/` alias (tsconfig `paths`, Vite `resolve.alias`); Tailwind v4 + `src/index.css` with
  new-york neutral tokens, dark mode from `prefers-color-scheme`, custom `--success`/`--warning`;
  `components.json`; `lib/utils.ts` (`cn`, with a Vitest test); `components/ui/sonner.tsx`.
- `main.tsx` loads `dev/mock-ipc.ts` only when `import.meta.env.MODE === "mock"`;
  `scripts/check-bundle.mjs` fails the build if the sentinel `__ENVDECK_MOCK_IPC__` is in `dist/`
  (verified: it fails on a `--mode mock` build and passes on a normal one).
- Rust: placeholder modules `error`, `state`, `manifest`, `scan`, `envfile`, `fsops`, `watch`,
  `commands`; `lib.rs` registers the three plugins and an empty handler.
- Template demo (`greet`, logos, `App.css`) removed; `App.tsx` is an empty sidebar + main shell.

Verified on Windows: full gate passes; `npm run tauri dev` opens the "EnvDeck" window;
`dev:mock` serves with the mock loaded. Not yet checked on macOS.

---

## M1: Rust foundations (done)

Notes from implementation (beyond the spec below):
- `Error` variants carry the path; `Error::io(path, e)` maps `NotFound`. `Stale` and `Exists`
  messages start with `STALE: ` / `EXISTS: ` for `errorText` to match. Added `InvalidDotenv`.
- The manifest keeps unknown keys (`extra`, flattened) so hand-added keys survive a save.
  `SettingsUpdate` (`deny_unknown_fields`, no `roots`/`library`) is the `save_manifest` payload (D2).
- `Inner` holds `config_path` and `home` too; the watcher handle is added in M8.
- `fsops::set_env_vars` (dotenv-name check + upsert + atomic write, keeps BOM) is shared by
  the `set_env_vars` command and the `merge` policy.
- Backups use `<name>.bak-<secs>`, then `-2`, ... so two in the same second don't collide.
- The symlink scope test uses a junction on Windows (no Developer Mode needed), so it runs on both OSes.
- `lib.rs` has `#[allow(dead_code)]` on the core modules until M4 wires them into commands.

### `error.rs`
`thiserror` enum, serialised to a **string** for the UI (`impl Serialize` → `to_string()`):
`Io`, `OutOfScope(PathBuf)`, `NotFound`, `TooLarge { bytes, max }`, `NotUtf8`,
`Stale` ("changed on disk, reload first"), `Exists(PathBuf)` (conflict policy `fail`),
`NotDotenv` (merge/upsert on a non-env file), `InvalidName`, `Manifest(String)`.
`pub type Result<T> = std::result::Result<T, Error>`. If the UI later needs to branch on a
variant (e.g. offer "Reload" on `Stale`), prefix messages with a stable code (`STALE: …`) and
parse that in `errorText` rather than switching to an object payload.

### `manifest.rs`
- `Manifest` struct: every field `Option<…>`, `#[serde(rename_all = "camelCase", default)]`,
  `skip_serializing_if = "Option::is_none"`, so a hand-edited file round-trips without gaining keys.
- `Resolved` view with defaults applied:
  - `include`: `.env`, `.env.*`, `*.env`, `.npmrc`, `.yarnrc.yml`, `appsettings*.json`,
    `application*.yml`, `application*.yaml`, `application*.properties`, `docker-compose*.yml`,
    `docker-compose*.yaml`, `compose*.yaml`, `.vscode/launch.json`, `.vscode/settings.json`
  - `excludeDirs`: `node_modules`, `.git`, `target`, `dist`, `build`, `bin`, `obj`, `.next`,
    `.nuxt`, `.venv`, `venv`, `__pycache__`, `.gradle`, `.idea`, `AppData`, `Library`
  - `maxDepth: 8`, `maxFileBytes: 524288`, `editor: "vscode"` (enum: `vscode | vscode-insiders |
    cursor | windsurf`; unknown → default plus a warning surfaced in the UI)
- `config_path()`: `ENVDECK_CONFIG` or `dirs::home_dir()/.envdeck.json`.
- `load()`: missing file → `Manifest::default()`; parse error → `Error::Manifest` (UI shows it
  and keeps running with defaults; never overwrite a file we couldn't parse).
- `save()`: pretty JSON (2-space), trailing newline, through `fsops::write_atomic`.
- `expand("~/x")` / `contract(path)` using the home dir; handle `~`, `~/`, `~\`.
- **Tests:** defaults, partial files, unknown keys ignored, `~` expand/contract on both separators,
  round-trip doesn't add keys, `ENVDECK_CONFIG` override (via a path param, not global env, so
  tests don't race).

### `state.rs`
- `AppState(Mutex<Inner>)`, `Inner { manifest: Manifest, manifest_error: Option<String>,
  session_roots: Vec<PathBuf>, dest_grants: Vec<PathBuf>, watcher: Option<WatchHandle> }`.
- Helpers that clone out what callers need (`scan_inputs()`, `read_scopes()`, `write_scopes()`)
  so no command holds the lock across `.await` or a dialog.
- `ensure_within(path, scopes) -> Result<PathBuf>`:
  1. reject relative paths;
  2. if the path exists, `dunce::canonicalize` it; otherwise canonicalize the **parent** and
     join the file name, rejecting names containing separators, `..`, or that are empty;
  3. canonicalize each scope root the same way;
  4. accept only if `canonical.starts_with(root)` (component-wise, so `/code2` ≠ `/code`).
  Symlinks pointing outside a root fail because the canonical target is checked.
- `Access::Read` = scan roots (saved + session) + library; `Access::Write` = those + `dest_grants`.
- **Tests (tempfile):** inside ok, outside rejected, `..` escape rejected, sibling-prefix
  (`root` vs `root2`) rejected, symlink out of root rejected (unix-only `#[cfg]`; on Windows use
  a junction only if trivially available, otherwise skip), non-existent target with valid parent
  ok, name with separator rejected, write grant not usable for reads.

### `fsops.rs`
- `read_text(path, max) -> Result<(String, u64 mtime_ms, u64 size)>`: check metadata size first,
  then read, refuse `TooLarge`/`NotUtf8`. Strip a UTF-8 BOM for parsing but remember it
  (`had_bom`) so saves keep it (common in `appsettings.json` from Visual Studio).
- `mtime_ms(path)`.
- `write_atomic(path, bytes)`:
  - resolve symlinks first and write to the **target**, so a symlinked `.env` stays a symlink;
  - temp file `.<name>.envdeck-tmp` in the same dir, `create_new`; write, `sync_all`;
  - copy permissions from the existing file (keeps `chmod 600` on macOS);
  - `std::fs::rename` (replace-existing on Windows). On Windows retry a few times with a short
    backoff on `PermissionDenied` (AV scanners / editors briefly holding the file);
  - on any failure remove the temp file.
- `write_checked(path, text, expected_mtime_ms)`: `Stale` if current mtime ≠ expected.
- `copy(src, dest_dir, file_name, policy) -> Result<CopyOutcome>` with
  `OnConflict { Fail (default), Backup, KeepBoth, Merge, Overwrite }`:
  - `Backup` → rename existing to `<name>.bak-<unix secs>` then write;
  - `KeepBoth` → `<name>.copy`, then `<name>.copy-2`, … (never overwrite a previous copy);
  - `Merge` → both must be dotenv: parse source, `envfile::upsert` into dest;
  - `Overwrite` → `write_atomic`.
  - Copy is read + `write_atomic`, not `fs::copy`, so it's atomic and size-capped.
  - `CopyOutcome { path, action: "created" | "backedUp" | "keptBoth" | "merged" | "overwritten", backupPath? }`.
- **Tests:** every policy with and without an existing dest, `KeepBoth` collisions, permissions
  preserved (unix), stale check, size cap, non-UTF-8 refusal, BOM preserved, temp file cleaned
  up when the destination dir is read-only.

---

## M2: dotenv engine (`envfile.rs`) (done)

Notes from implementation: `upsert` keeps each untouched line's own terminator (mixed files
stay byte-identical) and refuses files with an unterminated quote, since appended keys would land
inside it. `#` starts an inline comment only after whitespace (`COLOR=#fff` is a value).
`Parsed::vars()` gives last-wins values in first-appearance order. `is_dotenv_name` lives here.

Can be built in parallel with M1; pure functions, no I/O.

- Types (serialised to the UI, camelCase):
  ```rust
  enum Line { Blank, Comment { text }, Pair(Pair), Other { raw, reason } }
  struct Pair { key, value, quote: None|Single|Double|Backtick, export: bool,
                start_line: usize, end_line: usize, inline_comment: Option<String> }
  struct Parsed { lines: Vec<Line>, line_ending: Lf|Crlf, trailing_newline: bool }
  ```
- `parse(text)`: detect line ending from the first newline (mixed files: majority wins, and
  `upsert` writes new lines with that ending). Rules from ARCHITECTURE.md §dotenv: `export`
  prefix; keys `[A-Za-z_][A-Za-z0-9_.-]*`; whitespace around `=`; single quotes literal;
  double quotes with `\n \r \t \" \\` (other escapes kept literally); backticks literal;
  multi-line for any quote type until the closing quote; unterminated quote → `Other` covering
  to EOF; unquoted values end at ` #`; `KEY=` → empty value; `KEY` without `=` → `Other`.
- `quote_value(v)`: bare if `[A-Za-z0-9_./:@+,-]*` and non-empty; single quotes if it contains
  `$`, spaces, `#` or `"` and no `'` or newline; else double quotes with escapes.
- `upsert(text, vars: &[(key, value)]) -> String`:
  - for an existing key, replace the span of its **last** definition (`start_line..=end_line`),
    keeping `export` and any inline comment;
  - new keys are appended at the end in the given order, adding a newline first if the file
    lacked a trailing one;
  - every other byte is untouched; line ending preserved.
- `keys(parsed) -> Vec<(key, value)>` with last-wins semantics for compare.
- **Tests:** each quoting style; escapes; `export`; inline comments vs `#` inside quotes;
  multi-line PEM; unterminated quote; duplicates (last wins in read and upsert); empty values;
  CRLF in → CRLF out; no trailing newline; `parse(quote_value(v))` round-trips for a corpus of
  awkward values (`$HOME`, `a b`, `it's`, newline, `#`, unicode, empty); upsert that touches one
  key leaves the rest of the file byte-identical.

---

## M3: Scanner (`scan.rs`) (done)

Notes from implementation (beyond the spec below):
- Signature is `scan(roots: &[RootSpec], settings: &Settings, home) -> ScanResult`. Invalid
  include patterns are skipped and reported in `ScanResult.warnings` rather than failing a root.
- Globs are case-insensitive (`AppSettings.json` on Windows) and `*` doesn't cross `/`. A pattern
  starting with `/` is anchored to the root instead of getting `**/`.
- `ConfigFile` also has `projectRelPath` (project relative to root) so two projects both called
  `web` can be told apart; `relPath` is relative to the project.
- `RootStatus` also has `library`, `skipped` (unreadable entries) and `truncated` (per root,
  for M8/M9: don't watch a truncated root).
- Nested roots (e.g. library inside a scanned folder): each file is listed once, under the most
  specific root. Output keeps the caller's root order.
- Symlinked files are listed only if they resolve to a file inside the same root (otherwise the
  scope guard would refuse to read them). Symlinked dirs aren't followed.
- `scan::Matcher` (`is_included`, `in_excluded_dir`) is shared with the watcher in M8.
- Measured on Windows (debug build): `~` in 1.3 s (54 files), `C:\dev` 80 ms (release). An
  ignored test `scan_real` repeats this: `ENVDECK_SCAN_ROOT=~ cargo test scan_real -- --ignored --nocapture`.

- `scan(roots: &[RootSpec], cfg: &Resolved) -> ScanResult` (pure over the file system; the
  command wraps it in `spawn_blocking`).
- Walk: `WalkDir::new(root).follow_links(false).max_depth(cfg.max_depth)` with `filter_entry`
  pruning dirs whose name is in `excludeDirs` (exact match on the component; case-insensitive on
  Windows). Errors on individual entries (permission denied) are counted, not fatal.
- Globs: `GlobSet` from `include`, each pattern prefixed `**/` unless it already starts with `**/`
  or `/`; match against `slash(path relative to root)`. Invalid pattern → root status error, not panic.
- Project detection: walk up from the file's dir to the root, first dir containing a marker
  (list in ARCHITECTURE.md) wins; cache `dir → Option<project dir>` in a `HashMap` per scan.
  No marker → the file's own folder.
- Kind: by file name; `env-template` when an env-like name contains
  `example|sample|template|dist|defaults` as a dot-segment (`.env.example`, `example.env`);
  `.json/.yml/.yaml/.toml/.ini/.properties/.npmrc/.yarnrc*` mapped as per ARCHITECTURE.md;
  else `text`. `.npmrc` → `ini`.
- Cap: stop at 5,000 files total; set `truncated: true`.
- Result (camelCase):
  ```ts
  ScanResult { files: ConfigFile[], roots: RootStatus[], truncated: boolean, elapsedMs: number }
  ConfigFile { path, root, project, projectName, relPath, name, kind, size, modifiedMs }
  RootStatus { path, display /* ~-contracted */, saved: boolean, status: "ok"|"missing"|"error", message?, fileCount }
  ```
- Library is scanned as its own root (flagged `library: true`) so its files show in its own
  sidebar section.
- **Tests (tempfile trees):** excludes pruned (put a `.env` inside `node_modules`), nested
  `.env.*` in a monorepo, `.vscode/launch.json` at depth, grouping by nearest marker, no-marker
  fallback, every kind, `maxDepth`, truncation flag, `.gitignore` ignored on purpose (a `.env`
  listed in `.gitignore` is still found), missing root reported not fatal.

---

## M4: IPC surface

### `commands.rs`
Every path argument goes through `state::ensure_within` before use. Rust param names are
snake_case; Tauri exposes them camelCase to JS.

| Command | Notes |
| --- | --- |
| `get_manifest() -> ManifestView` | resolved values, `~`-contracted display paths, config path, parse error if any |
| `reload_manifest()` | re-read file, restart watcher |
| `save_manifest(settings)` | **only non-scope keys** (`include`, `excludeDirs`, `maxDepth`, `maxFileBytes`, `editor`). Roots and library can be changed only via pickers / `remove_folder`, otherwise a compromised page could grant itself `~`. (D2; documented in ARCHITECTURE.md.) |
| `add_folder(persist) -> Option<String>` | `tauri-plugin-dialog` blocking picker run via `spawn_blocking` (lock not held); `persist` → append to manifest roots + save; else session root. Restart watcher. |
| `save_folder(path)` | promote a session root (must already be one) to saved |
| `remove_folder(path)` | remove from saved or session; save manifest if saved |
| `set_library() -> Option<String>` | picker; save manifest; restart watcher |
| `scan() -> ScanResult` | `spawn_blocking` |
| `read_config(path) -> ConfigContent` | `{ path, text, kind, lineEnding, hasBom, modifiedMs, size, env?: Parsed }` |
| `write_config(path, content, expected_modified_ms) -> u64` | returns new mtime |
| `set_env_vars(path, vars) -> u64` | `upsert` + `write_atomic`; target must be dotenv |
| `pick_destination() -> Option<String>` | picker; adds a write grant for this session |
| `copy_config(src, dest_dir, on_conflict, file_name?) -> CopyOutcome` | `file_name` validated (no separators) |
| `create_from_template(path) -> String` | `.env.example` → `.env`, `example.env` → `.env`; `Exists` if present |
| `copy_files_to_clipboard(paths)` | `clipboard-rs` `set_files`; run on the main thread via `app.run_on_main_thread` + channel (NSPasteboard / OLE clipboard expect it) |
| `reveal(path)`, `start_drag(path)` | D1: Rust-side, scope-checked; `start_drag` runs on the main thread |

### `src/lib/ipc.ts`
- TS mirrors of every struct above and one typed wrapper per command (`invoke<T>("scan")`).
- `errorText(e: unknown): string` for `toast.error`.
- `onConfigsChanged(cb)` wrapping `listen("configs-changed")`.

### `src/dev/mock-ipc.ts`
- `mockIPC(handler, { shouldMockEvents: true })` from `@tauri-apps/api/mocks`, backed by an
  in-memory tree: 3–4 sample projects (a monorepo with `apps/web/.env`, `apps/api/.env`,
  `.env.example` missing a key, an `appsettings.Development.json`, a CRLF `.env`, a file with a
  multi-line PEM and an invalid line).
- Implements scan/read/write/upsert/copy/compare-relevant commands faithfully enough to exercise
  the UI, including `Stale` and `Exists` errors; pickers return a fixed fake folder.
- Contains the `__ENVDECK_MOCK_IPC__` sentinel.
- Loaded from `main.tsx` only under `if (import.meta.env.MODE === "mock") await import("./dev/mock-ipc")`
  so the branch is dead code in production builds; `check-bundle.mjs` verifies it.
- The TS dotenv parser for the mock is a small reimplementation; keep it obviously "mock only".

**Done when:** all commands registered, Rust tests green, `dev:mock` can call every wrapper.

---

## M5: Read-only UI

shadcn components to add (hand-write if the registry is blocked): `button`, `input`, `badge`,
`tabs`, `table`, `dialog`, `dropdown-menu`, `context-menu`, `tooltip`, `scroll-area`,
`separator`, `select`, `radio-group`, `checkbox`, `label`, `textarea`, `collapsible`, `alert`,
`kbd`, `sonner`, `resizable` (optional; a fixed 280px sidebar is fine to start).

- `lib/platform.ts`: `isMac`, `mod` label (`⌘` / `Ctrl+`), `shortcut("⇧C")`, reveal label
  (Finder / Explorer), `editorUrl(editor, path)` (`vscode://file/C:/…` with `/` on Windows,
  percent-encode spaces and `#`), `displayPath` (`~`-contract using home from `get_manifest`).
- `lib/env.ts` (pure, no React):
  - `isSecretKey` (`SECRET|TOKEN|PASSWORD|PASSWD|PWD|API_KEY|_KEY$|PRIVATE|CREDENTIAL|DSN|AUTH|COOKIE|SESSION|SALT`),
    `isSecretValue` (URL with userinfo password, PEM header, long high-entropy-looking string optional);
  - `mask(value)` fixed-width dots (don't leak length);
  - `compareEnv(a, b) -> { onlyA, onlyB, differs, same }`;
  - formatters: dotenv, `export` (single-quote escape `'\''`), PowerShell `$env:K = '…'`
    (`''` escape), cmd `set "K=v"` (flag values with `%`, `"` or newlines as unsafe), JSON object,
    `docker run -e` flags. Multi-line values: warn in the UI for shell formats.
- `hooks/use-workspace.ts`: manifest + scan state, `rescan()` (debounced 250 ms), selected file,
  loads `read_config` on select, exposes `truncated` and root errors.
- Components:
  - `sidebar.tsx`: filter (⌘/Ctrl+K) across project name, file name and rel path; projects
    grouped per root, collapsible; kind icons; Folders section with saved/session badges and a
    "…" menu (Save, Remove, Reload manifest, Open folder for this session); Library section;
    truncated and root-error alerts.
  - `file-view.tsx`: header with path (selectable), kind badge, action buttons, tabs
    (Variables / Source / Compare for dotenv; Source only otherwise).
  - `env-table.tsx`: key / value / flags columns, masked secrets with per-row and global reveal
    (state in memory, reset when switching files), `Other` lines flagged with their reason,
    duplicate keys flagged, row multi-select with checkboxes and shift-click.
  - `source-view.tsx`: monospaced, line numbers, dotenv values masked inline (render from parsed
    spans, not regex on raw text) until revealed.
  - `empty-state.tsx`: no roots → "Add folder" / "Open folder for this session"; no selection;
    no matches.
- Shortcuts: K filter, R rescan; never bind C, V, X, A, Z. `select-none` on chrome,
  `select-text` on paths, keys, values, source.

---

## M6: Getting configs out

- **Copy contents** (⇧C): clipboard-manager `writeText` of the raw file (unmasked; it's an
  explicit action). Toast "Copied".
- **Copy selected as…**: dropdown of formats from `lib/env.ts`; selection or all.
- **Copy path / relative path**.
- **Open in editor** (E): `openUrl(editorUrl(…))`; on failure toast "Is VS Code installed?".
- **Reveal**, **Copy file** (⇧F) via commands from M4.
- **Drag handle**: `start_drag` command (D1); the handle calls it on `pointerdown`/drag start.
- `hooks/use-copy.ts` centralises these and the toasts.
- Native-only features (file clipboard, drag, reveal, editor URL) can't be verified in
  `dev:mock`; the mock just toasts. Record native checks in the M9 checklist.

---

## M7: Writes in the UI

- **Source edit + save** (S): toggle to a `textarea`, editing shows the raw unmasked text with a
  warning banner; on save normalise `\r\n|\n` to the file's `lineEnding`, call `write_config`
  with the loaded mtime; on `Stale` show "Changed on disk" with Reload / Overwrite-after-review
  (Reload only is fine for v1). Leaving with unsaved changes asks for confirmation.
- **CopyToDialog**: destination list = projects from the scan + library + "Browse…"
  (`pick_destination`); file name input (prefilled, validated); conflict policy radio with
  `fail` selected by default and `merge` disabled unless both are dotenv; result toast states the
  action (and backup path).
- **Send to**: choose another dotenv file from the scan; preview which keys will be added vs
  replaced; `set_env_vars`.
- **CompareView**: pick the other side (defaults to the sibling template, else any env in the
  same project); table of only-here / only-there / differs / same with masking; **Add missing
  keys** upserts template keys (template values, or empty) into this file.
- **Create .env from template**: button on `env-template` files when no sibling `.env` exists.
- After every write: rescan + reload the open file (the watcher will also fire; debounce merges them).

---

## M8: Live updates (`watch.rs`)

- `restart(app, roots, library, cfg) -> WatchHandle`: one `notify-debouncer-full` debouncer per
  existing root, 400 ms, `RecursiveMode::Recursive`. Drop the old handles first.
- Filter each event: drop paths with an excluded component; emit if the path matches the include
  `GlobSet` or the event kind is remove/rename. Emit `configs-changed { paths: string[] }` once
  per debounced batch.
- Ignore our own temp files (`*.envdeck-tmp`).
- Call `restart` from `add_folder`, `remove_folder`, `set_library`, `reload_manifest` and setup.
- UI: rescan (debounced) and reload the open file if its path is in the batch, unless it's being
  edited (then show the "changed on disk" banner instead of clobbering the edit).
- **Tests:** the filter function is unit-tested; the watcher itself goes in the native smoke list.

---

## M9: Hardening, packaging, CI

- **Capability audit:** final `default.json` matches ARCHITECTURE.md §Security; no `fs`;
  opener URL scope only editor `://file/*`. Confirm the CSP blocks a test `fetch("https://…")`.
- **Logging audit:** grep for `println!`, `dbg!`, `eprintln!`, `console.log` touching contents.
- **No-storage audit:** grep for `localStorage`, `sessionStorage`, `indexedDB`, `app_data_dir`,
  `app_config_dir`, `tauri-plugin-store`.
- **Bundles:** icons regenerated from a real EnvDeck icon (`npm run tauri icon`); NSIS installer
  with WebView2 bootstrapper (default); macOS `.app` + `.dmg`; signing/notarisation settings
  documented, secrets left to CI.
- **CI** (`.github/workflows/ci.yml`): matrix `windows-latest`, `macos-latest`: `npm ci`, build,
  lint, `test:rust`, clippy `-D warnings`, `fmt --check`. Release workflow with
  `tauri-apps/tauri-action` (`--target universal-apple-darwin` on macOS) on tags.
- **README.md** rewrite: what it is, install, `~/.envdeck.json`, shortcuts, the no-storage promise.
- **Native smoke checklist** (run on both OSes, tick in the PR):
  add saved folder / session folder; `~/.envdeck.json` contents correct and `~`-relative; scan of
  a large tree is fast and `truncated` works when pointed at `~`; file clipboard paste in
  Finder/Explorer and the VS Code explorer; drag-out to the same three; reveal; `vscode://` link;
  edit in VS Code → EnvDeck updates; save from EnvDeck → VS Code sees it; CRLF file stays CRLF;
  `chmod 600 .env` survives a save (macOS); each conflict policy; stale save refused; dark mode.

---

## Decisions (resolved 2026-10-04)

- **D1. Drag-out and reveal run in Rust.** `start_drag(path)` (CrabNebula's `drag` crate,
  started on the main thread with the window handle) and `reveal(path)`
  (`tauri_plugin_opener::reveal_item_in_dir`) are EnvDeck commands that pass `ensure_within`.
  No drag or reveal permission in the capability file; no `@crabnebula/tauri-plugin-drag` npm package.
- **D2. `save_manifest` takes non-scope keys only** (`include`, `excludeDirs`, `maxDepth`,
  `maxFileBytes`, `editor`). Roots and library change only via pickers, `remove_folder`, or a
  hand edit + Reload.
- **D3. Vitest** for pure frontend logic in `src/lib` (`*.test.ts` next to the module); tests are
  added and updated as that logic grows (`lib/env.ts` in M5, `lib/platform.ts` URL/path helpers).
- **D4. Naming:** product `EnvDeck`, identifier `com.austi.envdeck` (same namespace as the
  scaffold's `com.austi.env-deck`, matching the product name). Treat it as fixed once a build is
  distributed: changing it moves macOS app data/permissions and Windows install keys.
- **D5. Edit mode** shows raw values behind an explicit Edit toggle with a warning banner; values
  are masked again on exit.

ARCHITECTURE.md and AGENTS.md were updated for D1–D3 and D5.

## Risks

- **Windows rename contention:** editors and AV can hold `.env` briefly; retry loop in
  `write_atomic`, and surface a clear error if it still fails.
- **Clipboard/drag threading:** file clipboard and drag must run on the main thread on macOS;
  plan for `run_on_main_thread` from the start.
- **Huge roots:** pointing at `~` or `C:\`: pruning + depth + 5,000 cap; watcher on such roots may
  be expensive on Windows (ReadDirectoryChangesW buffer overflows), so if a root is truncated,
  consider not watching it and showing "live updates off for this folder".
- **mtime resolution:** network shares / FAT have coarse mtimes; a save within the same tick
  could miss a concurrent change. Acceptable for v1; could add size + hash later.
- **Crate version drift:** `drag` and the Tauri plugins move with Tauri releases; `Cargo.lock` is committed, update deliberately.
