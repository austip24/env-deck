// Typed wrappers around EnvDeck's Rust commands: the ONLY place the UI calls Rust.
// Types mirror the serde structs in src-tauri/src (commands.rs, scan.rs, envfile.rs, fsops.rs,
// manifest.rs). Keep them in sync in the same change. Rust `Option<T>` arrives as `T | null`.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";

// --- manifest ---------------------------------------------------------------------------------

export type Editor = "vscode" | "vscode-insiders" | "cursor" | "windsurf";

export interface Settings {
  include: string[];
  excludeDirs: string[];
  maxDepth: number;
  maxFileBytes: number;
  editor: Editor;
}

/** What `save_manifest` accepts. Folders are deliberately not part of it. */
export type SettingsUpdate = Partial<Settings>;

export interface FolderView {
  path: string;
  /** `~`-contracted. */
  display: string;
  /** Saved in ~/.envdeck.json; false for "this session only" folders. */
  saved: boolean;
}

export interface ManifestView {
  configPath: string;
  configDisplay: string;
  home: string | null;
  roots: FolderView[];
  library: FolderView | null;
  settings: Settings;
  warnings: string[];
  /** The config file couldn't be read or parsed; EnvDeck won't save over it until fixed. */
  error: string | null;
}

// --- scan -------------------------------------------------------------------------------------

export type FileKind = "env" | "env-template" | "json" | "yaml" | "toml" | "ini" | "text";

export interface ConfigFile {
  path: string;
  root: string;
  project: string;
  projectName: string;
  /** Project folder relative to the root, `/`-separated ("" when it is the root). */
  projectRelPath: string;
  /** File relative to its project, `/`-separated. */
  relPath: string;
  name: string;
  kind: FileKind;
  size: number;
  modifiedMs: number;
}

export interface RootStatus {
  path: string;
  display: string;
  saved: boolean;
  library: boolean;
  status: "ok" | "missing" | "error";
  message: string | null;
  fileCount: number;
  skipped: number;
  truncated: boolean;
}

export interface ScanResult {
  files: ConfigFile[];
  roots: RootStatus[];
  truncated: boolean;
  warnings: string[];
  elapsedMs: number;
}

// --- dotenv -----------------------------------------------------------------------------------

export type LineEnding = "lf" | "crlf";
export type Quote = "none" | "single" | "double" | "backtick";

export interface EnvPair {
  key: string;
  value: string;
  quote: Quote;
  export: boolean;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  inlineComment: string | null;
}

export type EnvLine =
  | { type: "blank"; line: number }
  | { type: "comment"; line: number; text: string }
  | ({ type: "pair" } & EnvPair)
  | { type: "other"; startLine: number; endLine: number; raw: string; reason: string };

export interface ParsedEnv {
  lines: EnvLine[];
  lineEnding: LineEnding;
  trailingNewline: boolean;
}

export interface ConfigContent {
  path: string;
  name: string;
  kind: FileKind;
  text: string;
  lineEnding: LineEnding;
  hasBom: boolean;
  modifiedMs: number;
  size: number;
  /** Parsed lines for dotenv files, else null. */
  env: ParsedEnv | null;
}

export interface EnvVar {
  key: string;
  value: string;
}

// --- copy -------------------------------------------------------------------------------------

export type OnConflict = "fail" | "backup" | "keepBoth" | "merge" | "overwrite";
export type CopyAction = "created" | "backedUp" | "keptBoth" | "merged" | "overwritten";

export interface CopyOutcome {
  path: string;
  action: CopyAction;
  backupPath: string | null;
}

// --- GitHub (github.rs) ----------------------------------------------------------------------

export interface GithubRemote {
  /** The git remote's name (`origin`). */
  remote: string;
  host: string;
  owner: string;
  name: string;
}

export interface GithubRepoInfo {
  /** GitHub remotes of the repository next to the file, `origin` first. */
  remotes: GithubRemote[];
}

export interface GithubNames {
  secrets: string[];
  variables: string[];
}

/** What already exists on GitHub. Names only: values are never fetched. */
export interface GithubState {
  /** `owner/name`. */
  repo: string;
  /** The account the GitHub CLI (`gh auth login`) is signed in as on the repository's host. */
  login: string;
  environments: string[];
  repoNames: GithubNames;
  envNames: Record<string, GithubNames>;
  warnings: string[];
}

export type GithubKind = "secret" | "variable";

export interface GithubPushItem {
  key: string;
  kind: GithubKind;
  /** null for the repository itself. */
  environment: string | null;
}

export interface GithubPushResult extends GithubPushItem {
  /** null on success. */
  error: string | null;
}

// --- Azure App Service (azure.rs) -------------------------------------------------------------

/** The app named in `.azure/config` beside the file (written by `az webapp up`). */
export interface AzureHint {
  group: string | null;
  web: string | null;
}

export interface AzureSubscription {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface AzureAccount {
  /** The account the Azure CLI (`az login`) is signed in as. */
  user: string;
  /** Enabled subscriptions, the CLI's default first. */
  subscriptions: AzureSubscription[];
}

export interface AzureSite {
  /** ARM resource id. */
  id: string;
  name: string;
  resourceGroup: string;
  /** `app`, `app,linux`, `functionapp,linux`, ... */
  kind: string;
  location: string;
}

export type AzureFieldKind = "text" | "path" | "bool" | "count" | "choice";

/** A setting besides app settings and connection strings (catalog in azure.rs). */
export interface AzureField {
  id: string;
  label: string;
  section: "general" | "deployment";
  kind: AzureFieldKind;
  choices: string[];
  secret: boolean;
  /** The app setting a registry field writes, for "replaces". */
  appSetting: string | null;
  /** Where the field writes; two rows with the same target conflict. */
  target: string;
  note: string | null;
}

/** What already exists on the app or slot. Names only: values never leave Rust. */
export interface AzureState {
  site: string;
  slot: string | null;
  linux: boolean;
  appSettings: string[];
  connectionStrings: string[];
  stickyAppSettings: string[];
  stickyConnectionStrings: string[];
  fields: AzureField[];
  connectionTypes: string[];
  warnings: string[];
}

export type AzureDest = "appSetting" | "connectionString" | "field";

export interface AzurePushItem {
  /** The key in the file; Rust reads its value. */
  key: string;
  dest: AzureDest;
  /** App setting or connection string name (defaults to `key`). */
  name: string | null;
  /** Catalog id when `dest` is `field`. */
  field: string | null;
  connType: string | null;
  slotSetting: boolean;
}

export interface AzurePushResult {
  key: string;
  /** null on success. */
  error: string | null;
}

export type AzurePortalPage = "environment" | "configuration" | "deploymentCenter";

// --- updates (update.rs) ----------------------------------------------------------------------

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  /** Release notes, trimmed; null when the release has none. */
  notes: string | null;
  /** RFC 3339 publish date. */
  date: string | null;
}

export interface UpdateProgress {
  downloaded: number;
  /** Null when the server didn't send a length. */
  total: number | null;
}

// --- commands ---------------------------------------------------------------------------------

export const ipc = {
  getManifest: () => invoke<ManifestView>("get_manifest"),
  reloadManifest: () => invoke<ManifestView>("reload_manifest"),
  saveManifest: (settings: SettingsUpdate) => invoke<ManifestView>("save_manifest", { settings }),

  /** Native folder picker. `persist` saves it to ~/.envdeck.json; otherwise session only. */
  addFolder: (persist: boolean) => invoke<string | null>("add_folder", { persist }),
  /** Promote a session folder to a saved one. */
  saveFolder: (path: string) => invoke<void>("save_folder", { path }),
  /** Remove a saved folder, session folder or the library. */
  removeFolder: (path: string) => invoke<void>("remove_folder", { path }),
  setLibrary: () => invoke<string | null>("set_library"),

  scan: () => invoke<ScanResult>("scan"),
  readConfig: (path: string) => invoke<ConfigContent>("read_config", { path }),

  /** Save edited text; fails with a STALE error if the file changed since `expectedModifiedMs`. */
  writeConfig: (path: string, content: string, expectedModifiedMs: number) =>
    invoke<number>("write_config", { path, content, expectedModifiedMs }),
  /**
   * Upsert variables into a dotenv file. Returns the new mtime. With `expectedModifiedMs` (an
   * edit of the loaded file), fails with STALE if the file changed since.
   */
  setEnvVars: (path: string, vars: EnvVar[], expectedModifiedMs?: number) =>
    invoke<number>("set_env_vars", { path, vars, expectedModifiedMs: expectedModifiedMs ?? null }),

  /** Native folder picker that grants writes to the folder for this session. */
  pickDestination: () => invoke<string | null>("pick_destination"),
  copyConfig: (src: string, destDir: string, onConflict: OnConflict = "fail", fileName?: string) =>
    invoke<CopyOutcome>("copy_config", { src, destDir, onConflict, fileName: fileName ?? null }),
  /** `.env.example` -> `.env` beside it; never overwrites. Returns the new path. */
  createFromTemplate: (path: string) => invoke<string>("create_from_template", { path }),

  copyFilesToClipboard: (paths: string[]) => invoke<void>("copy_files_to_clipboard", { paths }),
  reveal: (path: string) => invoke<void>("reveal", { path }),
  /** Call from a pointer-down / drag-start handler. */
  startDrag: (path: string) => invoke<void>("start_drag", { path }),

  /** GitHub remotes of the repo whose `.git` is next to this dotenv file (NO_REPO if none). */
  githubRepo: (path: string) => invoke<GithubRepoInfo>("github_repo", { path }),
  /** Runs `gh` with its own login: who, environments and existing names. GH_AUTH when gh isn't signed in. */
  githubInspect: (path: string, remote: string) => invoke<GithubState>("github_inspect", { path, remote }),
  /** Sets each item from the file's current value (read by Rust); results are per item. */
  githubPush: (path: string, remote: string, items: GithubPushItem[]) =>
    invoke<GithubPushResult[]>("github_push", { path, remote, items }),
  /** Opens the repo's environment settings on GitHub (URL built in Rust). */
  githubOpenPage: (path: string, remote: string, page: "environments") =>
    invoke<void>("github_open_page", { path, remote, page }),

  /** The app named in `.azure/config` beside this dotenv file, or null. Reads one file. */
  azureHint: (path: string) => invoke<AzureHint | null>("azure_hint", { path }),
  /** Runs `az` with its own login: who and which subscriptions. AZ_AUTH when az isn't signed in. */
  azureAccount: () => invoke<AzureAccount>("azure_account"),
  /** App Services in a subscription; only these can be pushed to this session. */
  azureListApps: (subscription: string) => invoke<AzureSite[]>("azure_list_apps", { subscription }),
  azureListSlots: (siteId: string) => invoke<string[]>("azure_list_slots", { siteId }),
  /** Existing names on the app (slot null) or a slot, plus the settings catalog. */
  azureInspect: (siteId: string, slot: string | null) => invoke<AzureState>("azure_inspect", { siteId, slot }),
  /** Sets each item from the file's current value (read by Rust); results are per item. */
  azurePush: (path: string, siteId: string, slot: string | null, items: AzurePushItem[]) =>
    invoke<AzurePushResult[]>("azure_push", { path, siteId, slot, items }),
  /** Opens a portal page for the app or slot (URL built in Rust). */
  azureOpenPortal: (siteId: string, slot: string | null, page: AzurePortalPage) =>
    invoke<void>("azure_open_portal", { siteId, slot, page }),

  /** Asks EnvDeck's GitHub Releases for a newer version; null when up to date. */
  checkUpdate: () => invoke<UpdateInfo | null>("check_update"),
  /** Installs the update the last check found and restarts (NO_UPDATE without one). */
  installUpdate: () => invoke<void>("install_update"),

  // Plugin calls (permissions in capabilities/default.json).
  /** Plain text to the clipboard (clipboard-manager:allow-write-text). */
  writeClipboardText: (text: string) => writeText(text),
  /** Editor `://file/` URLs only; the opener scope rejects anything else. */
  openEditorUrl: (url: string) => openUrl(url),
};

/** Watcher push (M8): paths that changed on disk. */
export function onConfigsChanged(cb: (paths: string[]) => void): Promise<UnlistenFn> {
  return listen<{ paths: string[] }>("configs-changed", (e) => cb(e.payload.paths));
}

/** Download progress while an update installs. */
export function onUpdateProgress(cb: (p: UpdateProgress) => void): Promise<UnlistenFn> {
  return listen<UpdateProgress>("update-progress", (e) => cb(e.payload));
}

// --- errors -----------------------------------------------------------------------------------

/** Stable prefixes Rust puts on errors the UI reacts to (see error.rs). */
export type ErrorCode =
  | "STALE"
  | "EXISTS"
  | "GH_MISSING"
  | "GH_AUTH"
  | "NO_REPO"
  | "AZ_MISSING"
  | "AZ_AUTH"
  | "NO_UPDATE";

const CODE_RE = /^(STALE|EXISTS|GH_MISSING|GH_AUTH|NO_REPO|AZ_MISSING|AZ_AUTH|NO_UPDATE): /;

export function errorCode(e: unknown): ErrorCode | null {
  const m = CODE_RE.exec(rawError(e));
  return m ? (m[1] as ErrorCode) : null;
}

/** User-facing message for a command error, for `toast.error(errorText(e))`. */
export function errorText(e: unknown): string {
  return rawError(e).replace(CODE_RE, "");
}

function rawError(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
