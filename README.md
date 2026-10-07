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
Delete it and EnvDeck starts empty (and shows the short first-run tour again; **Settings ▸ Show
tutorial** opens it any time). **Open folder for this session** scans without writing
anything. EnvDeck's only network request of its own is the update check against this repository's GitHub
Releases (at launch and from **Settings ▸ Check for updates…**); **Push to GitHub** and **Push to
Azure App Service** run the GitHub and Azure CLIs when you choose them.

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
npm run dev:mock        # UI only, in a browser, against an in-memory mock (no Rust needed); add ?fresh to the URL for a first run
npm run build           # type-check + bundle (fails if the mock leaks into the bundle)
npm run lint            # oxlint
npm test                # Vitest
npm run test:rust       # cargo test
npm run smoke:native    # Windows: automated checks against the real app (see docs/SMOKE_TEST.md)
npm run tauri build     # .app/.dmg on macOS, NSIS/MSI on Windows
```

**Push to GitHub** runs the [GitHub CLI](https://cli.github.com) with the user's own login. Users
install `gh` and run `gh auth login` once. There is no EnvDeck GitHub App or OAuth App to set up,
install or approve, so it works on organization repositories without an owner's approval, as long as
the user can already change the repo's Actions secrets. EnvDeck never sees the token. For an
organization with SAML SSO, authorize gh's token for the org when gh asks.

**Push to Azure App Service** runs the [Azure CLI](https://aka.ms/azcli) with the user's own login
(`az login` once). Pick a subscription, app and slot (preselected from `.azure/config` beside the
file, as written by `az webapp up`), then send each key to an app setting, a connection string, a
general setting (startup command, always on, TLS, ...) or Deployment Center (container image and
registry, source repository and branch). Existing settings are kept; EnvDeck never deletes any.
Saving restarts the app. After a push to either service, EnvDeck offers to push the same keys to
the other.

## Release

1. `npm run release:version -- X.Y.Z` sets the version in `package.json`, `package-lock.json`,
   `src-tauri/Cargo.toml`, `Cargo.lock` and `src-tauri/tauri.conf.json`. Commit it.
2. Run the [native smoke test](docs/SMOKE_TEST.md) on both OSes.
3. Push a tag `vX.Y.Z`. The Release workflow builds Windows and macOS (universal) installers,
   signed updater bundles and `latest.json`, and attaches them to a draft GitHub release.
4. Check the draft, then **publish** it. Installed copies only see the update once it's published
   (they read `releases/latest`). The update dialog shows the notes in `latest.json`, which come
   from `releaseBody` in the workflow at build time; editing the release text afterwards doesn't
   change them.

**Update signing (one-time setup).** Run `npm run tauri signer generate -- -w ~/.tauri/envdeck.key`,
put the printed public key in `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`, and add the
private key's contents and its password as the `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` repository secrets. Keep the private key safe: without it,
installed copies can't be updated. A local `npm run tauri build` needs the same two environment
variables, because `createUpdaterArtifacts` is on.

**Signing.** macOS: add `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
`APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (app-specific) and `APPLE_TEAM_ID` as
repository secrets and uncomment them in `.github/workflows/release.yml`; tauri-action then signs
and notarizes. Windows: configure `bundle.windows.certificateThumbprint` (or a `signCommand`) in
`tauri.conf.json` once a certificate is available.

The app identifier is `com.austi.envdeck`. Don't change it after distributing a build: it decides
where macOS keeps the app's WebView data and how Windows identifies the installation.
