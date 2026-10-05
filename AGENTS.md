# AGENTS.md

Instructions for AI coding agents working on **EnvDeck**: a Tauri 2 + React + shadcn/ui
desktop app (macOS and Windows) that finds, compares and copies local `.env` and other
config files. Read [ARCHITECTURE.md](ARCHITECTURE.md) before making non-trivial changes;
it is the source of truth for design decisions. If a change conflicts with it, update the
doc in the same change or stop and ask.

## Stack

- **Shell:** Tauri 2 (Rust, stable toolchain, edition 2024)
- **Frontend:** React 19, TypeScript (strict), Vite, Tailwind CSS v4, shadcn/ui (new-york, neutral base with the blue theme, Radix via the `radix-ui` package), `lucide-react` icons, `sonner` toasts
- **Rust crates:** `walkdir`, `globset`, `notify-debouncer-full`, `clipboard-rs`, `drag`, `dunce`, `dirs`, `serde`, `thiserror`, `ureq` (GitHub sign-in only)
- **Tauri plugins:** `dialog`, `opener`, `clipboard-manager`. Drag-out uses CrabNebula's `drag` crate from Rust, not its JS plugin. **Not** `fs`, `store`, `sql` or `stronghold` (`tauri-plugin-dialog` pulls in the `fs` crate internally; it is never registered and has no capability).
- **Frontend tests:** Vitest

## UI

Shadcn Documentation: https://ui.shadcn.com/llms.txt

## Commands

```sh
npm install
npm run tauri dev          # run the native app
npm run dev:mock           # UI only, in a browser, with mock IPC (no Rust needed)
npm run build              # tsc + vite build (must pass)
npm run lint               # oxlint
npm test                   # vitest (src/**/*.test.ts)
npm run test:rust          # cargo test (builds the frontend first; Tauri needs ../dist)
npm run smoke:native       # Windows: automated checks against the real app (docs/SMOKE_TEST.md)
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets   # must be warning-free
cargo fmt --manifest-path src-tauri/Cargo.toml
npm run tauri build        # .app/.dmg on macOS, NSIS/MSI on Windows
```

Before calling a change done: `npm run build`, `npm run lint`, `npm test`, `npm run test:rust` and clippy all pass. `npm run build` also runs `scripts/check-bundle.mjs`, which fails if the mock IPC leaked into `dist/`.

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
  lib/github.ts       Push to GitHub: name rules, default rows, replace status
  dev/mock-ipc.ts     mock IPC for `dev:mock`; must never ship in the app bundle
scripts/
  check-bundle.mjs    post-build guard: fails if mock IPC is in dist/
src-tauri/
  capabilities/default.json   the webview's permissions (keep minimal)
  src/commands.rs     IPC surface
  src/state.rs        in-memory session state + scope guard (ensure_within)
  src/manifest.rs     ~/.envdeck.json load/save, defaults, ~ expansion
  src/scan.rs         folder walk, glob matching, project detection, file kinds
  src/envfile.rs      comment-preserving dotenv parser and upsert writer
  src/fsops.rs        size-capped reads, atomic writes, copy with conflict policy
  src/watch.rs        debounced recursive watcher -> `configs-changed` event
  src/github.rs       "Push to GitHub": .git remote detection, runs `gh` with the session token
  src/github_auth.rs  "Sign in with GitHub": GitHub App Device Flow, token in memory only
```

## Hard rules

These are product requirements. Do not work around them.

1. **No database, no app storage.** Never add SQLite, `localStorage`/`sessionStorage`/IndexedDB, the Tauri store plugin, app-data/app-config directories, caches on disk or the OS keychain. The file system is the source of truth.
   - The only file EnvDeck writes for itself is `~/.envdeck.json` (override: `ENVDECK_CONFIG`), and only when the user explicitly saves a folder, removes a saved folder or picks a library folder. Keep it pretty-printed JSON with `~`-relative paths and every key optional.
   - Anything else that must "persist" belongs in that file (if the user owns the setting) or in the user-chosen library folder (if it's content). Otherwise it lives in memory and is forgotten on quit.
2. **All file I/O goes through Rust commands.** Never add the `fs` plugin or give the webview direct file access.
3. **Every path from the webview passes `state::ensure_within`.** Reads must be inside a scan root or the library. Writes may also target a folder the user picked in a native dialog this session. Folder pickers run in Rust (`pick_folder`), never in the webview, so the page can't fake a grant. A new command that takes a path without this check is a security bug. This includes native actions: reveal and drag-out are EnvDeck commands (`reveal`, `start_drag`), not webview plugin calls. `save_manifest` must never accept `roots` or `library` from the webview.
4. **Writes are atomic and never silent.** Use `fsops::write_atomic` (temp file + rename). Copy uses an explicit `OnConflict` policy with `fail` as the default. Saving edited text passes the mtime it loaded and is refused if the file changed on disk.
5. **dotenv edits go through `envfile::upsert`.** Only change the lines for the keys being written. Preserve comments, key order, `export` prefixes and the file's line ending (CRLF must stay CRLF). Use `quote_value` for values; prefer single quotes so `$` isn't interpolated.
6. **Secrets stay masked by default** in every view that shows values (table, source, compare). Reveal state is in memory only. Never log file contents or values (no `println!`/`console.log` of them). EnvDeck makes no network calls except for **Push to GitHub**, and only after the user acts; don't add any others (no telemetry, no update checks without an explicit decision). For that feature:
   - **Sign-in** (`github_auth.rs`) is the Device Flow for the **EnvDeck GitHub App**, not an OAuth App, using `ureq`, which is only used there. The app's client ID and slug are compiled in from `ENVDECK_GITHUB_CLIENT_ID` and `ENVDECK_GITHUB_APP_SLUG`, set in `src-tauri/.cargo/config.toml`. Never add a client secret or private key. Tokens carry only the app's repository permissions: Secrets, Variables and Environments (read & write), Actions (read) and Metadata (read). They reach only repositories where the app is installed, and they expire after 8 hours. Don't add permissions, and in particular not `Administration`, without an explicit decision. Tokens, including the refresh token, live in Rust memory for the session (`state.github`, redacted in `Debug`). They are refreshed there, never written to disk or the keychain, never sent to the webview, and forgotten on sign-out, on quit, or when GitHub rejects them.
   - **Pushes** (`github.rs`, the only place that spawns processes) first check that the app is installed on the repo, then run the `gh` CLI with the token as `GH_TOKEN`. Values go to `gh` on stdin, never argv. Rust re-reads the values from disk and resolves the repo from `.git` itself. URLs EnvDeck opens (device login, app install, environment settings) are built in Rust. Nothing `gh` prints is logged.
7. **Capabilities stay minimal.** Adding a permission to `capabilities/default.json` (or widening the `opener:allow-open-url` scope beyond editor `://file/*` URLs) needs a reason in the PR description.
8. **Don't honour `.gitignore` when scanning.** `.env` files are usually git-ignored; that's why the app exists. Exclusions come from `excludeDirs`.

## Cross-platform (macOS + Windows)

- Treat both as first-class; Linux may build but isn't a target.
- Paths: never build them with string concatenation in Rust; use `Path`/`PathBuf`. Use `dunce::canonicalize` (not `std::fs::canonicalize`) so Windows paths don't get a `\\?\` prefix. Match globs against `/`-normalised paths (`scan::slash`).
- `~` is expanded with `manifest::expand` and collapsed with `manifest::contract`; use those, not ad-hoc logic.
- In the UI, use `lib/platform.ts` for shortcut labels (`⌘` vs `Ctrl+`), reveal labels (Finder vs Explorer) and editor URLs (`vscode://file/C:/...` on Windows).
- Default excludes include `bin`, `obj` and `AppData` (Windows) and `Library` (macOS). Keep them.
- Features that only work natively (drag-out, file-object clipboard, dialogs, reveal, watcher) can't be checked with `dev:mock`. On Windows, `npm run smoke:native` covers the scope guard, writes, watcher, CSP and permissions against the real app; the rest is the manual list in `docs/SMOKE_TEST.md`. Say so explicitly when you change native features and haven't run them.

## Frontend conventions

- Components are function components in kebab-case files exporting PascalCase names; use the `@/` alias.
- UI primitives come from `src/components/ui` (shadcn). To add one, write it in shadcn's new-york style using `radix-ui` and `cn()` from `@/lib/utils`. If `npx shadcn add` can't reach the registry (some sandboxes block `ui.shadcn.com`), hand-write it to match the existing files.
- Theme colours are CSS variables in `src/index.css` (`--success`, `--warning` are custom). Use tokens (`text-muted-foreground`, `bg-sidebar`), not raw colours, so dark mode works. The app follows the OS theme.
- New IPC calls get a typed wrapper in `lib/ipc.ts` and, where useful, a handler in `dev/mock-ipc.ts` so `dev:mock` keeps working.
- Errors from commands are strings; show them with `toast.error(errorText(e))`.
- Text users copy (paths, keys, values, source) must stay selectable (`select-text`/`.selectable`); the rest of the chrome is `select-none` like a native app.
- Keyboard shortcuts (⌘ on macOS, Ctrl on Windows): K filter, R rescan, B toggle sidebar, ⇧C copy contents, ⇧F copy file, E open in editor, S save while editing. Keep them consistent and don't take over C, V, X, A or Z.

## Rust conventions

- Commands return `error::Result<T>`; add a variant to `error::Error` rather than returning ad-hoc strings when the UI needs to react to it (e.g. `Stale`).
- Serde structs crossing IPC use `#[serde(rename_all = "camelCase")]`; mirror them in `lib/ipc.ts` in the same change.
- Never hold the `AppState` mutex across `.await` or a blocking dialog. Copy what you need out of the lock first. Long work (scans) runs in `spawn_blocking`.
- Restart the watcher (`watch::restart`) whenever roots or the library change.

## Testing

- Unit-test Rust logic in the same file (`#[cfg(test)]`), using `tempfile` for anything touching disk. Required coverage areas: dotenv parsing and quoting round-trips, upsert (comments, CRLF, multi-line), every `OnConflict` policy, scanner exclusion/grouping/kinds, and the scope guard (including `..` escapes).
- Unit-test pure frontend logic (`src/lib`, especially `lib/env.ts`: secret detection, masking, compare, every copy-as format and its escaping) with Vitest in a sibling `*.test.ts`. Add or update tests whenever that logic changes.
- A bug fix comes with a test that fails before the fix.
- For UI changes, run `npm run dev:mock` and check light and dark themes.

## Out of scope unless asked

Cloud sync, accounts, secret-manager integrations (Vault, 1Password, Doppler; pushing to GitHub Actions secrets/variables, with GitHub sign-in, is the one integration in scope), encryption at rest, auto-update and telemetry. Ideas the team has noted are in ARCHITECTURE.md, "Later ideas".
