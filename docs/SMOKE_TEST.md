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
| 19 | Build with `ENVDECK_GITHUB_CLIENT_ID` and `ENVDECK_GITHUB_APP_SLUG` filled in `src-tauri/.cargo/config.toml`. The **GitHub** button shows for every dotenv file; it's enabled only with `.git` in the same folder, and the disabled tooltip says why. **Sign in with GitHub** shows a code, opens github.com/login/device, and after approval shows "Signed in as @you". Cancel stops a pending sign-in | ☐ | ☐ |
| 20 | On a repo without the app: "EnvDeck isn't installed" → **Install on GitHub** opens the app's install page → install on that repo only → **Try again** loads. An org repo you don't own shows the same prompt (install request needs owner approval) | ☐ | ☐ |
| 21 | Push one repo secret, one repo variable, one environment secret and one environment variable; `gh secret list` / `gh variable list` (with `--env`) show them; a multi-line value and a CRLF file arrive intact. Reopen: those rows show **replaces**. **Manage environments** opens the repo's environment settings; add one there, then refresh (↻) to see it. An SSH remote (`git@github.com:…`) is detected | ☐ | ☐ |
| 22 | Works with `gh` installed but logged out (EnvDeck's sign-in is used). Revoke the app's authorization (github.com/settings/apps/authorizations): the next push asks to sign in again. Restarting EnvDeck forgets the sign-in. Leave EnvDeck open past 8 hours: the next push still works (token refreshed). With `gh` off PATH (macOS: launched from Finder, `gh` from Homebrew) it is still found; if uninstalled, "GitHub CLI not found" | ☐ | ☐ |
| 23 | Windows: no console window flashes while the dialog runs `gh` | ☐ | ☐ |
