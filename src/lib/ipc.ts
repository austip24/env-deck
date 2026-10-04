// Typed wrappers around EnvDeck's Rust commands: the ONLY place the UI calls Rust.
// Types mirror the serde structs in src-tauri/src (commands.rs, scan.rs, envfile.rs, fsops.rs,
// manifest.rs). Keep them in sync in the same change. Rust `Option<T>` arrives as `T | null`.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

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
  /** Upsert variables into a dotenv file. Returns the new mtime. */
  setEnvVars: (path: string, vars: EnvVar[]) => invoke<number>("set_env_vars", { path, vars }),

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
};

/** Watcher push (M8): paths that changed on disk. */
export function onConfigsChanged(cb: (paths: string[]) => void): Promise<UnlistenFn> {
  return listen<{ paths: string[] }>("configs-changed", (e) => cb(e.payload.paths));
}

// --- errors -----------------------------------------------------------------------------------

/** Stable prefixes Rust puts on errors the UI reacts to (see error.rs). */
export type ErrorCode = "STALE" | "EXISTS";

const CODE_RE = /^(STALE|EXISTS): /;

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
