# EnvDeck

A desktop app for macOS and Windows that finds the `.env` and other config files spread across
your projects, shows them with secrets masked, compares them with their templates, and copies
them where you need them: as text, as a file you can paste or drag into VS Code, or into another
project.

- **Finds what git ignores.** Scans your code folders for `.env`, `.env.*`, `*.env`, `.npmrc`,
  `appsettings*.json`, `application*.yml`, `docker-compose*.yml`, `.vscode/launch.json` and more,
  grouped by project. `node_modules`, `bin`, `obj`, `target` and friends are skipped.
- **Secrets stay masked** until you reveal them, in the table, the source view and comparisons.
- **Copy it out:** contents, selected variables as `export`/PowerShell/`cmd`/JSON/`docker -e`,
  the file itself (paste into Finder, Explorer or the VS Code explorer), drag-out, or **Copy to…**
  another project with an explicit conflict policy (fail, back up, keep both, merge, replace).
- **Keep files in sync:** compare a `.env` with its `.env.example` and add missing keys, send
  variables to another `.env`, create `.env` from a template. Edits keep comments, key order,
  `export` prefixes and CRLF line endings.
- **Live:** changes made in your editor show up immediately.

## No database, no storage

EnvDeck owns no data. Your files are read fresh from disk, and the only file EnvDeck writes for
itself is `~/.envdeck.json` (Windows: `%USERPROFILE%\.envdeck.json`), and only when you save a
folder, remove one or pick a library folder:

```json
{
  "roots": ["~/code", "D:\\work\\clients"],
  "library": "~/dev-configs",
  "include": [".env", ".env.*", "*.env", ".npmrc", "appsettings*.json"],
  "excludeDirs": ["node_modules", ".git", "target", "dist", "bin", "obj"],
  "maxDepth": 8,
  "maxFileBytes": 524288,
  "editor": "vscode"
}
```

Every key is optional; hand-edit it and choose **Settings ▸ Reload config file**. `editor` can be
`vscode`, `vscode-insiders`, `cursor` or `windsurf`. Set `ENVDECK_CONFIG` to use a different file.
Delete it and EnvDeck starts empty. **Open folder for this session** scans without writing
anything. EnvDeck makes no network calls.

## Shortcuts

| Action | macOS | Windows |
| --- | --- | --- |
| Filter files | ⌘K | Ctrl+K |
| Rescan | ⌘R | Ctrl+R |
| Toggle sidebar | ⌘B | Ctrl+B |
| Copy contents | ⇧⌘C | Ctrl+Shift+C |
| Copy file | ⇧⌘F | Ctrl+Shift+F |
| Open in editor | ⌘E | Ctrl+E |
| Save while editing | ⌘S | Ctrl+S |

## Install

Download the installer from the [releases](../../releases): `.dmg` on macOS (universal),
`-setup.exe` (NSIS) or `.msi` on Windows. Windows needs WebView2, which the installer fetches if
it's missing. Builds aren't code-signed yet, so macOS Gatekeeper and Windows SmartScreen will ask
for confirmation on first launch.

## Develop

Requires Node 22+ and stable Rust. See [AGENTS.md](AGENTS.md) for conventions and
[ARCHITECTURE.md](ARCHITECTURE.md) for the design.

```sh
npm install
npm run tauri dev       # the native app
npm run dev:mock        # UI only, in a browser, against an in-memory mock (no Rust needed)
npm run build           # type-check + bundle (fails if the mock leaks into the bundle)
npm run lint            # oxlint
npm test                # Vitest
npm run test:rust       # cargo test
npm run smoke:native    # Windows: automated checks against the real app (see docs/SMOKE_TEST.md)
npm run tauri build     # .app/.dmg on macOS, NSIS/MSI on Windows
```

**GitHub sign-in** ("Push to GitHub") uses the **EnvDeck GitHub App**. To create it, go to GitHub →
Settings → Developer settings → GitHub Apps → New GitHub App:

- **Identifying and authorizing users:** tick **Enable Device Flow** and keep **Expire user
  authorization tokens** on. The Callback URL can be any URL you own; it isn't used.
- **Webhook:** untick **Active**.
- **Repository permissions:** Secrets, Variables and Environments **Read and write**; Actions
  **Read-only**; Metadata **Read-only**. No account or organization permissions, and not
  Administration.
- **Where can this GitHub App be installed:** "Any account" if other people will use EnvDeck.
- Don't generate a client secret or private key for EnvDeck; the Device Flow doesn't need them.

Then put the app's **client ID** (`Iv23li…`) and **slug** (from `github.com/apps/<slug>`) in
[`src-tauri/.cargo/config.toml`](src-tauri/.cargo/config.toml). Neither is secret, so the file is
committed, and local builds and the release workflow both use it. An environment variable with the
same name overrides the file. Users install the app on the repositories they want to push to (EnvDeck links there),
and need the [GitHub CLI](https://cli.github.com) installed (no `gh auth login` needed).

## Release

1. Bump `version` in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`.
2. Run the [native smoke test](docs/SMOKE_TEST.md) on both OSes.
3. Push a tag `vX.Y.Z`. The Release workflow builds Windows and macOS (universal) installers and
   attaches them to a draft GitHub release.

**Signing.** macOS: add `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
`APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (app-specific) and `APPLE_TEAM_ID` as
repository secrets and uncomment them in `.github/workflows/release.yml`; tauri-action then signs
and notarizes. Windows: configure `bundle.windows.certificateThumbprint` (or a `signCommand`) in
`tauri.conf.json` once a certificate is available.

The app identifier is `com.austi.envdeck`. Don't change it after distributing a build: it decides
where macOS keeps the app's WebView data and how Windows identifies the installation.
