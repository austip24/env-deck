# EnvDeck: architecture design

EnvDeck is a desktop app (macOS and Windows) for finding, reading, comparing and
copying the local configuration files developers juggle every day: `.env` files
and their templates, `.npmrc`, `appsettings.*.json`, `application.yml`,
`docker-compose*.yml`, `.vscode/launch.json` and similar.

Stack: **Tauri 2** (Rust core, system webview) + **React 19 / Vite** + **Tailwind v4 / shadcn/ui**.

## 1. The "no database, no storage" rule

EnvDeck owns no data. The file system is the only source of truth.

| Concern                                                                     | Where it lives                                                                                                                                                            |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config files                                                                | Where they already are. Read fresh from disk on every view.                                                                                                               |
| File index                                                                  | In memory only, rebuilt by every scan (milliseconds for typical code folders).                                                                                            |
| Which folders to scan                                                       | `~/.envdeck.json` (Windows: `%USERPROFILE%\.envdeck.json`), a plain JSON file **the user owns**. `ENVDECK_CONFIG` overrides the path.                                     |
| Saved / reusable configs                                                    | An optional **library folder** the user picks (e.g. `~/dev-configs`). It's just a folder: version it with git, sync it with iCloud/OneDrive, or point it at a team share. |
| UI state (selection, revealed secrets, session folders, destination grants) | React state / Rust memory. Gone when the app quits, by design.                                                                                                            |

What this means in practice:

- No app-data directory, no SQLite, no `localStorage`, no Tauri store plugin, no keychain. The webview never persists anything.
- The app writes `~/.envdeck.json` only when the user explicitly adds/removes a saved folder or picks a library folder. It's pretty-printed, uses `~`-relative paths so it's portable between machines, and can be hand-edited, then picked up with **Settings ▸ Reload config file**.
- "Open folder for this session" scans a folder without writing anything at all.
- If the user deletes `~/.envdeck.json`, the app just starts empty. Nothing else is left behind.
- The first-run tutorial (`tutorial-dialog.tsx`) isn't remembered either. It opens by itself when the first manifest loaded has no folders, no library and no error, i.e. a fresh start or a deleted `~/.envdeck.json`. Dismissing it is in-memory only, and **Settings ▸ Show tutorial** reopens it. There is deliberately no "seen" flag.
- The one exception is outside EnvDeck's control: the system webview keeps a runtime folder (`%LOCALAPPDATA%\com.austi.envdeck\EBWebView` on Windows, WebKit's per-app folder on macOS). The window runs in private mode (`incognito: true`), so no cache, cookies or web storage are written there; it's safe to delete.

Example `~/.envdeck.json`:

```json
{
	"roots": ["~/code", "D:\\work\\clients"],
	"library": "~/dev-configs",
	"include": [
		".env",
		".env.*",
		"*.env",
		".npmrc",
		"appsettings*.json",
		".vscode/launch.json"
	],
	"excludeDirs": ["node_modules", ".git", "target", "dist", "bin", "obj"],
	"maxDepth": 8,
	"maxFileBytes": 524288,
	"editor": "vscode"
}
```

Every key is optional and has a built-in default. Keys EnvDeck doesn't recognise are kept when it saves the file, and a file it can't parse is reported and never overwritten.

## 2. Component map

```
┌──────────────────────── Webview (React + shadcn/ui) ────────────────────────┐
│ Sidebar        project tree, filter (⌘/Ctrl+K), folders, library;           │
│                resizable, hides with ⌘/Ctrl+B (layout is memory-only)       │
│ FileView       header actions, drag handle, tabs                            │
│   EnvTable     masked key/value table, multi-select, copy-as, send-to       │
│   SourceView   raw text, masked for dotenv, edit + save with stale check    │
│   CompareView  key diff vs template or another env, "add missing keys"      │
│ CopyToDialog   destination, file name, conflict policy                      │
│ lib/env.ts     secret detection, masking, compare, clipboard formats        │
│ lib/ipc.ts     typed invoke() wrappers  ◄── the only way to touch files     │
└──────────────┬───────────────────────────────────────▲──────────────────────┘
               │ invoke()                              │ event: configs-changed
┌──────────────▼───────────────────────────────────────┴──────────────────────┐
│ Rust core (src-tauri/src)                                                    │
│ commands.rs  IPC surface; every path goes through state::ensure_within()     │
│ state.rs     in-memory session state + scope guard                           │
│ manifest.rs  load/save ~/.envdeck.json, ~ expansion                          │
│ scan.rs      walkdir + globset scan, project detection, file kinds           │
│ envfile.rs   comment-preserving dotenv parser + upsert writer                │
│ fsops.rs     size-capped reads, atomic writes, copy with conflict policy     │
│ watch.rs     debounced recursive watcher (FSEvents / ReadDirectoryChangesW)  │
│ plugins      dialog, opener, clipboard-manager; `drag` crate (CrabNebula)    │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Scanning (`scan.rs`)

- Walks each root with `walkdir` (no symlink following, `maxDepth` 8 by default) and **prunes** `excludeDirs` before descending, so `node_modules` and friends cost nothing.
- Deliberately does **not** honour `.gitignore`: `.env` files are almost always git-ignored, which is exactly why they need a tool.
- Matches `include` globs with `globset`, case-insensitively. Every pattern is anchored with `**/`, so `.env.*` and `.vscode/launch.json` match at any depth (monorepos work); a pattern starting with `/` matches only at the root.
- Symlinked files are listed only when they resolve to a file inside the same root (the scope guard would refuse anything else). When roots are nested (a library inside a scanned folder), each file is listed once, under the most specific root.
- Groups each file under its **project**: the nearest ancestor with a marker (`.git`, `package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `global.json`, `Directory.Build.props`, `pom.xml`, `build.gradle`, `composer.json`, `Gemfile`, `deno.json`). Lookups are cached per directory; with no marker, the file's own folder is the project.
- Classifies kind: `env`, `env-template` (`example|sample|template|dist|defaults`), `json`, `yaml`, `toml`, `ini`, `text`.
- Caps at 5,000 files and reports `truncated` so a mis-pointed root (`~`) degrades gracefully.

### dotenv engine (`envfile.rs`)

One parser shared by viewing, comparing and writing, covering the dialect used by dotenvy, Node `dotenv`, Docker and Compose:

- `export` prefix, `'single'` (literal), `"double"` (escapes `\n \r \t \" \\`), `` `backtick` `` quotes
- multi-line quoted values (PEM keys, certs)
- inline `# comments` after unquoted values (a `#` needs whitespace before it, so `COLOR=#fff` is a value and `KEY= # note` is empty with a comment)
- invalid lines are kept as `other` and flagged in the UI instead of silently dropped

`upsert()` changes only the lines for the keys being written (last definition wins, multi-line spans are replaced whole) and appends new keys at the end. Comments, ordering, `export` prefixes and **CRLF line endings** are preserved, which matters on Windows teams. `quote_value()` picks the safest quoting: bare when possible, single quotes for anything with `$` or spaces (no accidental interpolation), double quotes with escapes otherwise. Round-trip tests cover this.

### Writes are safe by construction (`fsops.rs`)

- **Atomic:** write to `.<name>.envdeck-tmp` in the same folder, then `rename` (which replaces on Windows too, with a short retry if an editor or virus scanner holds the file). A crash never leaves half a `.env`. A symlinked file is written through to its target, Unix permissions (e.g. `600`) are kept, and a UTF-8 BOM (common in Visual Studio's `appsettings.json`) is preserved.
- **No silent overwrite:** copy takes an explicit policy: `fail` (default), `backup` (`<name>.bak-<unix>`), `keepBoth` (`<name>.copy`), `merge` (dotenv upsert), `overwrite`.
- **Optimistic concurrency:** the editor sends the mtime it loaded. If the file changed on disk since then, the save is refused with a "reload first" error.
- **Size cap:** reads over `maxFileBytes` (512 KB default) or non-UTF-8 files are refused, so a stray binary can't freeze the UI.

### Security model

These files hold secrets, so the webview gets as little power as possible.

- **No `fs` plugin.** The frontend can't read or write arbitrary paths. All file I/O goes through EnvDeck's own commands.
- **Scope guard.** Every command canonicalises the path (via `dunce`, so no `\\?\` prefixes on Windows) and requires it to be inside a scan root or the library (reads), or additionally a destination the user picked in a **native** folder dialog this session (writes). `..` escapes and symlink tricks fail the check. Destination grants live in memory only.
- **Folder pickers run in Rust**, so a compromised page can't fabricate a "user picked this folder" grant.
- **Native actions that take a path run in Rust.** Reveal-in-folder (`reveal`), drag-out (`start_drag`, using CrabNebula's `drag` crate directly rather than its JS plugin) and the file-object clipboard go through EnvDeck commands, so their paths pass the same scope guard as reads.
- **The manifest's scope can't be set from the page.** `save_manifest` accepts only non-scope settings (`include`, `excludeDirs`, `maxDepth`, `maxFileBytes`, `editor`). `roots` and `library` change only through the native pickers, `remove_folder`, or the user hand-editing the file and choosing Reload. Otherwise a compromised page could grant itself `~`.
- **Capabilities** (`capabilities/default.json`) allow only: listening for events (`core:event:allow-listen`/`allow-unlisten`), clipboard text write, and opening `vscode://`, `vscode-insiders://`, `cursor://` and `windsurf://` file URLs. A strict CSP blocks remote scripts and network access from the page. The updater has no webview permission: it runs from Rust (`check_update`, `install_update`).
- **Masking.** Values whose key looks secret (`SECRET`, `TOKEN`, `PASSWORD`, `API_KEY`, `_KEY`, `DSN`, ...) or that are URLs with embedded passwords are masked in the table, source view and compare view until revealed (globally or per value). In JSON, YAML, TOML and INI sources (`appsettings.json`, `.npmrc`, ...) the same rules are applied line by line to `"key": "value"`, `key: value` and `key = value` lines, as a best effort. The reveal state is never persisted. Editing a file in the source view necessarily shows raw values: it's an explicit Edit mode with a warning banner, and values are masked again on leaving it.
- Nothing is logged. EnvDeck's only network request of its own is the **update check** (below). The other network traffic is the `gh` and `az` runs behind the user-initiated **Push to GitHub** and **Push to Azure App Service** (below). Both CLIs are spawned through `cli.rs` only.
- **Updates (`update.rs`).** `tauri-plugin-updater`, driven from Rust. At launch (silently; offline is fine) and on **Settings ▸ Check for updates…**, it fetches `https://github.com/austip24/env-deck/releases/latest/download/latest.json`, a fixed endpoint in `tauri.conf.json`. The request carries nothing about the user beyond what any HTTP request does. A newer version shows a toast, an **Update** button in the sidebar footer and a dialog with the release notes. **Install and restart** downloads the bundle into memory, verifies its minisign signature against the `pubkey` in `tauri.conf.json` (a tampered or unsigned bundle is refused), then installs: on Windows the NSIS installer runs in passive mode and closes the app (the updater writes it to the OS temp folder; that's the installer's file, not app storage, and the one process EnvDeck starts outside `cli.rs`); on macOS the `.app` is replaced and EnvDeck restarts. The webview only says "check" and "install": the found update (URL, signature) stays in Rust memory, and "Later" is forgotten on quit. Releases are drafts until published, and `releases/latest` ignores drafts, so publishing the draft is what ships an update.
- **Push to GitHub (`github.rs`).** The repository is the `.git` (directory, or `gitdir:` file for worktrees/submodules) in the same folder as the dotenv file; Rust reads its `config` and keeps remotes with an `owner/repo` URL. The webview only names a remote and keys: Rust re-checks the file against the scope guard, resolves the remote itself (so the page can't target an arbitrary repo) and re-reads the values from disk (so values never cross IPC and only keys in the file can be pushed). Values are written to `gh secret set` / `gh variable set` on **stdin**, never argv (visible in process listings). `gh` does the API calls and sealed-box encryption. It runs with **gh's own credentials, untouched** (no `GH_TOKEN` injected or cleared), with prompts and its update notifier disabled, and with no console window on Windows. Every call names its host (`--repo host/owner/name` or `--hostname`), so GitHub Enterprise Server remotes work wherever gh is signed in. gh's "not signed in" output, or a 401, becomes `GH_AUTH`, and the dialog shows `gh auth login` with **Try again**. Existing secrets/variables are listed by name only. No capability or CSP change: everything runs in Rust.
- **Authentication: the GitHub CLI's login.** EnvDeck has no sign-in of its own. `gh` uses whatever the user set up with `gh auth login` (its keyring or config) or `GH_TOKEN` in its environment. `github_inspect` first runs `gh api --hostname <host> user --jq .login`, which is both the sign-in check and the "Using GitHub CLI as @login" label.
  - **Why not a GitHub App or OAuth App:** an earlier version used an EnvDeck GitHub App with the Device Flow. An app has to be installed on each repository, and for an organization that needs an owner's approval. OAuth Apps hit the same wall when an org restricts third-party access, which is the default for new orgs. gh's login reaches any repository the user can already change, with no approval step.
  - **Trade-off:** gh's token is broader (by default it has the `repo`, `read:org` and `gist` scopes) and longer-lived than the app's 8-hour, repository-scoped token. It is the user's existing credential, managed and stored by gh. EnvDeck never reads, receives or stores it, never runs `gh auth token`, and never reads gh's config. Hard rule 1 is unaffected: EnvDeck writes nothing for this feature.
  - **Permissions** are whatever the user has. Setting secrets and variables needs write access. Some lists, like variables, may need admin. Failures are reported per key, with a hint about write access and `gh auth refresh -s repo`. For SAML SSO organizations, gh's own message, which names the org and the authorize URL, is passed through.
  - EnvDeck still **doesn't create environments**. That changes repository settings, so **Manage environments** opens the repository's environment settings instead.
- **Push to Azure App Service (`azure.rs`).** The same model as GitHub, with the Azure CLI. There's no reliable local link to an app, so the dialog picks **subscription → app → slot** from `az account list` and `az resource list --resource-type Microsoft.Web/sites`. `.azure/config` beside the file (`[defaults] group`, `web`, as written by `az webapp up`) preselects the app. Rust remembers the app ids it listed this session (`AppState::azure_sites`, memory only) and refuses any other, so the page can't aim `az` at an arbitrary resource; slot names are validated too.
  - **Authentication: the Azure CLI's login** (`az login`), untouched. `az account show` is the sign-in check and the "Using Azure CLI as …" label. Its "run az login" and `AADSTS…` errors become `AZ_AUTH`, and the dialog shows `az login` with **Try again**. EnvDeck never runs `az account get-access-token` and never reads `~/.azure`. It sets `AZURE_CORE_ONLY_SHOW_ERRORS`, `AZURE_CORE_NO_COLOR`, `AZURE_CORE_COLLECT_TELEMETRY=false` and `AZURE_CORE_SURVEY_MESSAGE=false` for its own runs. On Windows `az` is `az.cmd`, a batch file that would run through cmd.exe's quoting, so EnvDeck runs the CLI's bundled `python.exe -IBm azure.cli` the way `az.cmd` does.
  - **Writes** all go through `az rest --method put|patch --uri /subscriptions/…?api-version=2023-12-01 --body @-`. The CLI reads `@-` from stdin, so values never appear in argv, and a relative URI uses the signed-in cloud's ARM endpoint. ARM replaces app settings, connection strings and `slotConfigNames` as whole collections, so Rust lists the current ones (`POST …/config/appsettings/list`), merges in only the pushed keys and writes the result back, as `az webapp config appsettings set` does. Existing values live in Rust memory for that one call and never reach the webview. Nothing is ever deleted. The read-modify-write has a small race with someone editing in the portal at the same moment.
  - **Destinations** per key: app setting (any name `[A-Za-z0-9_.:-]`; Linux apps get a note about names they won't see as-is; empty values allowed), connection string (with type, `Custom` by default; `ConnectionStrings__Name` keys start as connection string `Name`), or a field from the fixed `azure::FIELDS` catalog: general settings (`PATCH config/web`: startup command, runtime stack, always on, HTTP 2.0, web sockets, 32-bit worker, minimum TLS, FTP state, health check path, worker count, with typed parsing) and Deployment Center (container image as `linuxFxVersion = DOCKER|…` on Linux apps only, `DOCKER_REGISTRY_SERVER_URL/USERNAME/PASSWORD` app settings, and `sourcecontrols/web` repository URL and branch, merged with what's there). Two rows that write the same place are refused. "Slot setting" adds the name to the production site's `slotConfigNames`.
  - One request per kind and target, so a push is at most a handful of `az` runs. Saving settings restarts the app, and changing the source starts a deployment; the dialog says so above **Push**. **Portal** opens the app's environment variables, configuration or Deployment Center (URL built in Rust).
- **Cross-push.** When a push to one service succeeds for any keys, closing its dialog asks "Also push to …?" for the other service (GitHub only when the file has a GitHub remote). Accepting opens the other dialog with exactly those keys checked. A push started from that prompt never prompts back. Nothing is remembered (`lib/cross-push.ts`).

### Live updates (`watch.rs`)

One recursive watcher per root (FSEvents on macOS, ReadDirectoryChangesW on Windows), debounced at 400 ms. Events inside excluded dirs are dropped. Events matching an include glob, or any remove/rename that might take configs with it, are emitted to the webview as `configs-changed` with the paths (an empty list means "rescan everything", e.g. after a watcher overflow). The UI rescans (debounced) and reloads the open file if it's one of them, so editing `.env` in VS Code shows up in EnvDeck immediately. If you're editing that file in EnvDeck with unsaved changes, the editor warns straight away and still refuses to save over the newer version. The watcher is rebuilt whenever roots change.

## 3. Getting configs _out_: copy/paste into VS Code and the file system

This is the core job, so there are several routes, each matching a real habit:

| Action                                | How it works                                                                                                                                     | Typical use                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| **Copy contents** (⌘/Ctrl+⇧C)         | Text to clipboard                                                                                                                                | Paste into a new file in VS Code                                        |
| **Copy file** (⌘/Ctrl+⇧F)             | Puts the _file itself_ on the OS clipboard (`clipboard-rs`: `NSPasteboard` file URLs on macOS, `CF_HDROP` on Windows)                            | ⌘V in Finder/Explorer, or paste into the VS Code explorer               |
| **Drag handle**                       | Native drag-out via the `drag` crate, started by the `start_drag` command after the scope check                                                  | Drop the file onto a folder in the VS Code explorer, Finder or Explorer |
| **Copy to…**                          | Pick a project from the scan, the library, or Browse; rename; choose a conflict policy                                                           | "Give `web/` the same `.env` as `api/`, but back up the old one"        |
| **Copy selected as…**                 | Selected (or all) variables formatted as `KEY=value`, `export` (bash/zsh), `$env:` (PowerShell), `set` (cmd.exe), JSON, or `docker run -e` flags | Paste into a terminal, CI secret UI, `launch.json` `env` block          |
| **Push to Azure App Service**         | **Azure** button for dotenv files. Pick subscription, app and slot (preselected from `.azure/config`), then per key: app setting, connection string, a general setting or Deployment Center field, optionally as a slot setting. Uses `az login`. Shows which names would be replaced; never deletes | Seed an App Service's settings from `.env`, then the same keys to GitHub |
| **Push to GitHub**                    | **GitHub** button in the file header for dotenv files; enabled when `.git` is beside the file (the tooltip says why not), with `gh` installed and signed in. Per key: secret or variable, and the repository or one of its existing environments (**Manage environments** opens GitHub's settings to add one). Uses the GitHub CLI's own login (`gh auth login`), so no app install or org approval is needed. Shows which names already exist and would be replaced. Runs `gh` from Rust | Seed a repo's Actions secrets and per-environment variables from `.env` |
| **Send to**                           | Upsert selected variables into another dotenv file, keeping its comments and order. Templates and EnvDeck's backups aren't offered as targets       | Promote three keys from `.env` to `.env.local`                          |
| **Compare ▸ Add missing keys**        | Upsert keys present in the template/other file but missing here                                                                                  | Catch up after someone adds a key to `.env.example`                     |
| **Create .env from template**         | `.env.example` → `.env` (refuses to overwrite)                                                                                                   | Fresh clone setup                                                       |
| **Open in editor** (⌘/Ctrl+E)         | `vscode://file/<path>` via the opener plugin; works without `code` on PATH. `editor` in the manifest switches to Insiders, Cursor or Windsurf.   | Jump to the file                                                        |
| **Copy path / relative path, Reveal** | Clipboard / `reveal` command (opener's reveal, called from Rust)                                                                                 | Everything else                                                         |

## 4. IPC surface

| Command                                                               | Purpose                                                                     |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `get_manifest`, `reload_manifest`, `save_manifest`                    | Read or write `~/.envdeck.json` (`save_manifest`: non-scope keys only)      |
| `add_folder(persist)`, `save_folder`, `remove_folder`                 | Native picker; saved vs session-only roots                                  |
| `set_library`                                                         | Native picker for the library folder                                        |
| `scan`                                                                | Walk all roots (on a blocking thread) and return files plus per-root status |
| `read_config`                                                         | Text plus parsed dotenv lines, line ending, mtime                           |
| `write_config(path, content, expectedModifiedMs)`                     | Atomic save with stale check                                                |
| `set_env_vars(path, vars, expectedModifiedMs?)`                       | Comment-preserving upsert; with the mtime (a value edited in the table, by double-click), refused if the file changed |
| `pick_destination`, `copy_config(src, destDir, onConflict, fileName)` | Copy with policy                                                            |
| `create_from_template`                                                | `.env.example` → `.env`                                                     |
| `copy_files_to_clipboard(paths)`                                      | File-object clipboard                                                       |
| `reveal(path)`, `start_drag(path)`                                    | Reveal in Finder/Explorer; native drag-out                                  |
| `github_repo(path)`                                                   | GitHub remotes of the `.git` beside a dotenv file (file reads only)         |
| `github_open_page(path, remote, page)`                                | Open the repo's environment settings (URL built in Rust) |
| `github_inspect(path, remote)`                                        | Via `gh`: the gh login, environments and existing secret/variable names (never values)   |
| `github_push(path, remote, items)`                                    | Via `gh`: set each key from the file on disk; per-item results              |
| `azure_hint(path)`                                                    | The app named in `.azure/config` beside a dotenv file (file read only)      |
| `azure_account()`, `azure_list_apps(subscription)`, `azure_list_slots(siteId)` | Via `az`: login and subscriptions, App Services (remembered as push targets), slots |
| `azure_inspect(siteId, slot)`                                         | Via `az`: existing app setting / connection string / slot setting names (never values), the field catalog |
| `azure_push(path, siteId, slot, items)`                               | Via `az rest`: merge each key from the file on disk; per-item results       |
| `azure_open_portal(siteId, slot, page)`                               | Open a portal page for the app (URL built in Rust)                          |
| `check_update()`, `install_update()`                                  | Ask GitHub Releases for a newer version; install the one found and restart  |
| event `configs-changed`                                               | Watcher push with changed paths                                             |
| event `update-progress`                                               | Download progress (`downloaded`, `total`) while an update installs          |

Command argument and result types are mirrored as TypeScript types in `src/lib/ipc.ts`.

## 5. Cross-platform notes

- **Paths:** stored and shown natively; globs are matched on `/`-normalised paths so one pattern set works on both OSes. `~` is expanded on both.
- **Line endings:** read as-is, preserved on upsert and on editor save (the editor normalises to the file's own ending).
- **Windows:** `rename` replaces existing files; `dunce` avoids UNC-prefixed paths in the UI; `bin`/`obj`/`AppData` are excluded by default; the installer bootstraps WebView2 if missing. Shortcuts render as `Ctrl+…`.
- **macOS:** FSEvents makes recursive watching cheap; Finder reveal and file clipboard use native APIs; `Library` is excluded by default; shortcuts render as `⌘…`. For distribution, sign and notarize (Tauri's `bundle.macOS.signingIdentity` plus `APPLE_*` env vars in CI).
- **Bundles:** `.app` + `.dmg` on macOS, NSIS + MSI on Windows (`tauri.conf.json`). A GitHub Actions matrix with `tauri-apps/tauri-action` on `macos-latest` (universal: `--target universal-apple-darwin`) and `windows-latest` is the release pipeline (`.github/workflows/release.yml`). It also signs the updater bundles (`TAURI_SIGNING_PRIVATE_KEY`) and uploads `latest.json`, preferring the NSIS installer on Windows.

## 6. Proposed project layout

```
envdeck/
├─ src/                         React + shadcn/ui
│  ├─ components/               sidebar, file-view, env-table, source-view,
│  │                            compare-view, copy-to-dialog, empty-state, ui/ (shadcn)
│  ├─ hooks/use-workspace.ts    manifest + scan state, configs-changed listener
│  ├─ lib/ipc.ts                typed invoke() wrappers (only path to files)
│  ├─ lib/env.ts                secret detection, masking, compare, copy formats
│  └─ dev/mock-ipc.ts           fake IPC so the UI runs in a browser (dev only)
└─ src-tauri/
   ├─ capabilities/default.json
   └─ src/ commands.rs state.rs manifest.rs scan.rs envfile.rs fsops.rs watch.rs update.rs
```

Key dependencies: `tauri` 2, `tauri-plugin-{dialog,opener,clipboard-manager,updater}`, `drag` (CrabNebula), `walkdir`, `globset`, `notify-debouncer-full`, `clipboard-rs`, `dunce`, `dirs`, `serde`, `thiserror`; frontend `radix-ui`, `lucide-react`, `sonner`, Tailwind v4.

## 7. Testing strategy

- **Rust unit tests** for the risky parts: dotenv parsing (quotes, `export`, multi-line, inline comments), upsert preserving comments and CRLF, quoting round-trips, every copy conflict policy, scanner exclusion/grouping/kinds, and the scope guard rejecting `..` and out-of-root paths.
- **Frontend unit tests (Vitest)** for the pure logic in `src/lib` (secret detection, masking, compare, clipboard/shell formats and their escaping). Grow them as that logic grows.
- **UI in a browser** against mock IPC for fast iteration and screenshot tests.
- **Native smoke test per OS** for what only works natively: drag-out, file-object clipboard, folder dialogs, reveal, `vscode://` links, watcher events.

## 8. Later ideas

- **Key search across all files** ("which projects define `STRIPE_KEY`?"): a Rust command that parses every dotenv in the scan on demand. Still no index.
- **Profiles / switch:** treat `.env.staging`, `.env.prod` siblings as profiles and "activate" one by copying it over `.env` with the backup policy.
- **Library sets:** folders inside the library as named bundles (`library/payments-local/{.env,.npmrc}`) applied to a project in one action.
- **Tray / quick-copy palette:** a global shortcut opening a command palette to copy a value without switching windows.
- **Structured viewers** for JSON/YAML (collapsible tree, copy a sub-object).
- **Leak checks:** warn when a scanned `.env` is _not_ git-ignored.
