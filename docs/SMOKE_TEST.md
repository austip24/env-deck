# Native smoke test

Run before a release, on **both** Windows and macOS. `dev:mock` can't exercise any of this:
it all depends on the native shell.

## 1. Automated checks (Windows)

```sh
npm run smoke:native
```

Starts `npm run tauri dev` against a throwaway sandbox (`ENVDECK_CONFIG` points at a temp file, so
your `~/.envdeck.json` is never touched), drives the real WebView2 page over the DevTools protocol
and stops the app. It checks:

- the scope guard (outside roots, `..` escapes, system files, ungranted destinations, path-like
  file names) for reads, writes, reveal, drag and the file clipboard;
- stale-save refusal, CRLF-preserving upsert, copy policies, create-from-template;
- `save_manifest` refusing `roots`; the `fs` plugin, window commands and non-editor URLs being
  unreachable; the CSP blocking network requests;
- watcher events for an external edit (and none for `node_modules`); ⌘/Ctrl+R not reloading.

There's no macOS equivalent yet (WKWebView has no DevTools protocol), so on macOS do section 2
by hand, plus a pass over the scope checks above via the UI if anything in `state.rs` or
`commands.rs` changed.

## 2. By hand (both OSes)

Use a scratch folder with a couple of projects (`git init`, a `.env`, a `.env.example`, a
CRLF `.env` on Windows, a `node_modules/x/.env` that must not show up).

| # | Check | Windows | macOS |
| --- | --- | --- | --- |
| 1 | **Add folder…** opens the native picker; the folder appears and `~/.envdeck.json` gains a `~`-relative entry | ☐ | ☐ |
| 2 | **Open folder for this session…** scans without writing `~/.envdeck.json` | ☐ | ☐ |
| 3 | **Choose library folder…** shows a Library section | ☐ | ☐ |
| 4 | Edit `.env` in VS Code → EnvDeck updates within a second | ☐ | ☐ |
| 5 | **Copy** (⌘/Ctrl+⇧C) and **Copy as → export** paste correctly into a terminal | ☐ | ☐ |
| 6 | **Copy file** (⌘/Ctrl+⇧F) pastes into Finder/Explorer **and** the VS Code explorer | ☐ | ☐ |
| 7 | **Drag handle** drops the file into Finder/Explorer **and** the VS Code explorer | ☐ | ☐ |
| 8 | **Open in VS Code** (⌘/Ctrl+E) opens the file (also with `"editor": "cursor"` if installed) | ☐ | ☐ |
| 9 | **Reveal in Finder / Show in Explorer** selects the file | ☐ | ☐ |
| 10 | **Edit → Save** writes the file; a CRLF file stays CRLF; a `chmod 600` file stays `600` (macOS) | ☐ | ☐ |
| 11 | Edit, change the file in VS Code, return: "changed on disk" banner, save refused | ☐ | ☐ |
| 12 | **Copy to… → Browse…** a folder outside the roots, copy there; each conflict policy behaves as labelled | ☐ | ☐ |
| 13 | **Compare → Add missing keys** against `.env.example` | ☐ | ☐ |
| 14 | Light and dark mode both follow the OS setting | ☐ | ☐ |
| 15 | Installer: NSIS/MSI install, launch, uninstall (Windows); open the `.dmg`, drag to Applications, launch (macOS) | ☐ | ☐ |
| 16 | Point a root at `~`: scan stops at 5,000 files with a warning, app stays responsive | ☐ | ☐ |
| 17 | Drag the sidebar edge: resizes smoothly, stops at min/max, snaps to the rail when dragged narrow; ⌘/Ctrl+B toggles | ☐ | ☐ |
| 18 | **Remove library…** (⋯, right-click or Settings) asks first, drops `library` from `~/.envdeck.json`, leaves the folder on disk | ☐ | ☐ |
| 19 | The **GitHub** button shows for every dotenv file; it's enabled only with `.git` in the same folder, and the disabled tooltip says why. After `gh auth logout`, the dialog shows "GitHub CLI isn't signed in" with a copyable `gh auth login`. Run it in a terminal, then **Try again**: the header shows "Using GitHub CLI as @you" | ☐ | ☐ |
| 20 | An **organization** repo you can write to, with no EnvDeck app installed and nothing approved by an owner, loads and pushes. With SAML SSO and an unauthorized gh token, the error names the org and the authorize URL. A repo you can only read shows the write-access/`repo` scope hint per key | ☐ | ☐ |
| 21 | Push one repo secret, one repo variable, one environment secret and one environment variable; `gh secret list` / `gh variable list` (with `--env`) show them; a multi-line value and a CRLF file arrive intact. Reopen: those rows show **replaces**. **Manage environments** opens the repo's environment settings; add one there, then refresh (↻) to see it. An SSH remote (`git@github.com:…`) is detected | ☐ | ☐ |
| 22 | `gh auth switch` to another account, then refresh (↻): the header shows the new login. EnvDeck writes nothing for itself (no token in `~/.envdeck.json` or elsewhere). With `gh` off PATH (macOS: launched from Finder, `gh` from Homebrew) it is still found; if uninstalled, "GitHub CLI not found" | ☐ | ☐ |
| 23 | Windows: no console window flashes while the dialog runs `gh` | ☐ | ☐ |
| 24 | The **Azure** button shows for every dotenv file. After `az logout`, the dialog shows "Azure CLI isn't signed in" with a copyable `az login`; sign in, **Try again**: "Using Azure CLI as you@…". With `az` uninstalled: "Azure CLI not found". On Windows (MSI install, `az.cmd` on PATH) and macOS (Homebrew, launched from Finder) `az` is found, and no console window flashes | ☐ | ☐ |
| 25 | A folder with `.azure/config` (`az webapp up`) preselects that app. On a **test** app's staging slot, push one app setting (slot setting on), one connection string (SQLAzure) and the startup command. The portal shows them, the existing settings are unchanged, and the slot setting is ticked. Reopen: those rows show **replaces** | ☐ | ☐ |
| 26 | Push a container image and the registry password to a Linux test app (Deployment Center shows them); the same on a Windows app reports "Linux apps" for the image. Push a repository URL and branch to a test app with external Git: a deployment starts | ☐ | ☐ |
| 27 | While a push runs, the values don't appear in the process list (`Get-CimInstance Win32_Process` CommandLine / `ps -eww`) | ☐ | ☐ |
| 28 | With `ENVDECK_CONFIG` pointing at a missing file, the tutorial opens on launch. Its **Choose library folder…** and **Add folder…** buttons open the native pickers and show a ✓ once picked; cancelling a picker changes nothing. Relaunch with the saved config: no tutorial. **Settings ▸ Show tutorial** reopens it at step 1 | ☐ | ☐ |
| 29 | After a GitHub push, "Also push to Azure App Service?" appears with the pushed keys; **Push to Azure…** opens the Azure dialog with only those keys checked, and pushing there doesn't ask again. The reverse works when the file has a GitHub repo; **Not now** closes it | ☐ | ☐ |
| 30 | Updates: install an older published release, then publish a newer one. On launch a toast says it's available and the footer shows **Update X.Y.Z**; the dialog shows the notes; **Install and restart** shows progress, installs (NSIS passive on Windows) and relaunches the new version | ☐ | ☐ |
| 31 | Updates: an offline launch shows nothing; **Settings ▸ Check for updates…** offline shows an error toast, and on the latest version "EnvDeck is up to date". A `latest.json` with a wrong `signature` is refused at install | ☐ | ☐ |
