# AGENTS.md

Instructions for AI coding agents working on **EnvDeck**: a Tauri 2 + React + shadcn/ui
desktop app (macOS and Windows) that finds, compares and copies local `.env` and other
config files. Read [ARCHITECTURE.md](ARCHITECTURE.md) before making non-trivial changes;
it is the source of truth for design decisions. If a change conflicts with it, update the
doc in the same change or stop and ask.

## Stack

- **Shell:** Tauri 2 (Rust, stable toolchain, edition 2024)
- **Frontend:** React 19, TypeScript (strict), Vite, Tailwind CSS v4, shadcn/ui (new-york, neutral, Radix via the `radix-ui` package), `lucide-react` icons, `sonner` toasts
- **Rust crates:** `walkdir`, `globset`, `notify-debouncer-full`, `clipboard-rs`, `dunce`, `dirs`, `serde`, `thiserror`
- **Tauri plugins:** `dialog`, `opener`, `clipboard-manager`, `drag` (CrabNebula). **Not** `fs`, `store`, `sql` or `stronghold`.

## Commands

```sh
npm install
npm run tauri dev          # run the native app
npm run dev:mock           # UI only, in a browser, with mock IPC (no Rust needed)
npm run build              # tsc + vite build (must pass)
npm run lint               # oxlint
npm run test:rust          # cargo test (builds the frontend first; Tauri needs ../dist)
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets   # must be warning-free
cargo fmt --manifest-path src-tauri/Cargo.toml
npm run tauri build        # .app/.dmg on macOS, NSIS/MSI on Windows
```

Before calling a change done: `npm run build`, `npm run lint`, `npm run test:rust` and clippy all pass.

## Layout

```
src/
  components/         app components (sidebar, file-view, env-table, source-view,
                      compare-view, copy-to-dialog, empty-state)
  components/ui/      shadcn components (copied source; edit in place)
  hooks/              use-workspace (manifest + scan + watcher events), use-copy
  lib/ipc.ts          typed invoke() wrappers: the ONLY place the UI calls Rust
  lib/env.ts          secret detection, masking, compare, clipboard formats
  lib/platform.ts     OS detection, shortcut labels, editor URLs, path display
  dev/mock-ipc.ts     mock IPC for `dev:mock`; must never ship in the app bundle
src-tauri/
  capabilities/default.json   the webview's permissions (keep minimal)
  src/commands.rs     IPC surface
  src/state.rs        in-memory session state + scope guard (ensure_within)
  src/manifest.rs     ~/.envdeck.json load/save, defaults, ~ expansion
  src/scan.rs         folder walk, glob matching, project detection, file kinds
  src/envfile.rs      comment-preserving dotenv parser and upsert writer
  src/fsops.rs        size-capped reads, atomic writes, copy with conflict policy
  src/watch.rs        debounced recursive watcher -> `configs-changed` event
```

## Hard rules

These are product requirements. Do not work around them.

1. **No database, no app storage.** Never add SQLite, `localStorage`/`sessionStorage`/IndexedDB, the Tauri store plugin, app-data/app-config directories, caches on disk or the OS keychain. The file system is the source of truth.
   - The only file EnvDeck writes for itself is `~/.envdeck.json` (override: `ENVDECK_CONFIG`), and only when the user explicitly saves a folder, removes a saved folder or picks a library folder. Keep it pretty-printed JSON with `~`-relative paths and every key optional.
   - Anything else that must "persist" belongs in that file (if the user owns the setting) or in the user-chosen library folder (if it's content). Otherwise it lives in memory and is forgotten on quit.
2. **All file I/O goes through Rust commands.** Never add the `fs` plugin or give the webview direct file access.
3. **Every path from the webview passes `state::ensure_within`.** Reads must be inside a scan root or the library. Writes may also target a folder the user picked in a native dialog this session. Folder pickers run in Rust (`pick_folder`), never in the webview, so the page can't fake a grant. A new command that takes a path without this check is a security bug.
4. **Writes are atomic and never silent.** Use `fsops::write_atomic` (temp file + rename). Copy uses an explicit `OnConflict` policy with `fail` as the default. Saving edited text passes the mtime it loaded and is refused if the file changed on disk.
5. **dotenv edits go through `envfile::upsert`.** Only change the lines for the keys being written. Preserve comments, key order, `export` prefixes and the file's line ending (CRLF must stay CRLF). Use `quote_value` for values; prefer single quotes so `$` isn't interpolated.
6. **Secrets stay masked by default** in every view that shows values (table, source, compare). Reveal state is in memory only. Never log file contents or values (no `println!`/`console.log` of them). EnvDeck makes no network calls; don't add any (no telemetry, no update checks without an explicit decision).
7. **Capabilities stay minimal.** Adding a permission to `capabilities/default.json` (or widening the `opener:allow-open-url` scope beyond editor `://file/*` URLs) needs a reason in the PR description.
8. **Don't honour `.gitignore` when scanning.** `.env` files are usually git-ignored; that's why the app exists. Exclusions come from `excludeDirs`.

## Cross-platform (macOS + Windows)

- Treat both as first-class; Linux may build but isn't a target.
- Paths: never build them with string concatenation in Rust; use `Path`/`PathBuf`. Use `dunce::canonicalize` (not `std::fs::canonicalize`) so Windows paths don't get a `\\?\` prefix. Match globs against `/`-normalised paths (`scan::slash`).
- `~` is expanded with `manifest::expand` and collapsed with `manifest::contract`; use those, not ad-hoc logic.
- In the UI, use `lib/platform.ts` for shortcut labels (`⌘` vs `Ctrl+`), reveal labels (Finder vs Explorer) and editor URLs (`vscode://file/C:/...` on Windows).
- Default excludes include `bin`, `obj` and `AppData` (Windows) and `Library` (macOS). Keep them.
- Features that only work natively (drag-out, file-object clipboard, dialogs, reveal, watcher) can't be checked with `dev:mock`. Say so explicitly when you change them and haven't run the native app.

## Frontend conventions

- Components are function components in kebab-case files exporting PascalCase names; use the `@/` alias.
- UI primitives come from `src/components/ui` (shadcn). To add one, write it in shadcn's new-york style using `radix-ui` and `cn()` from `@/lib/utils`. If `npx shadcn add` can't reach the registry (some sandboxes block `ui.shadcn.com`), hand-write it to match the existing files.
- Theme colours are CSS variables in `src/index.css` (`--success`, `--warning` are custom). Use tokens (`text-muted-foreground`, `bg-sidebar`), not raw colours, so dark mode works. The app follows the OS theme.
- New IPC calls get a typed wrapper in `lib/ipc.ts` and, where useful, a handler in `dev/mock-ipc.ts` so `dev:mock` keeps working.
- Errors from commands are strings; show them with `toast.error(errorText(e))`.
- Text users copy (paths, keys, values, source) must stay selectable (`select-text`/`.selectable`); the rest of the chrome is `select-none` like a native app.
- Keyboard shortcuts (⌘ on macOS, Ctrl on Windows): K filter, R rescan, ⇧C copy contents, ⇧F copy file, E open in editor, S save while editing. Keep them consistent and don't take over C, V, X, A or Z.

## Rust conventions

- Commands return `error::Result<T>`; add a variant to `error::Error` rather than returning ad-hoc strings when the UI needs to react to it (e.g. `Stale`).
- Serde structs crossing IPC use `#[serde(rename_all = "camelCase")]`; mirror them in `lib/ipc.ts` in the same change.
- Never hold the `AppState` mutex across `.await` or a blocking dialog. Copy what you need out of the lock first. Long work (scans) runs in `spawn_blocking`.
- Restart the watcher (`watch::restart`) whenever roots or the library change.

## Testing

- Unit-test Rust logic in the same file (`#[cfg(test)]`), using `tempfile` for anything touching disk. Required coverage areas: dotenv parsing and quoting round-trips, upsert (comments, CRLF, multi-line), every `OnConflict` policy, scanner exclusion/grouping/kinds, and the scope guard (including `..` escapes).
- A bug fix comes with a test that fails before the fix.
- For UI changes, run `npm run dev:mock` and check light and dark themes.

## Out of scope unless asked

Cloud sync, accounts, secret-manager integrations (Vault, 1Password, Doppler), encryption at rest, auto-update and telemetry. Ideas the team has noted are in ARCHITECTURE.md, "Later ideas".
