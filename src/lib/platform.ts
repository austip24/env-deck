// OS detection, shortcut labels, editor URLs and path display. macOS and Windows are both
// first-class: use these helpers instead of hard-coding `⌘`, "Finder" or `/`.

import type { Editor } from "@/lib/ipc";

export const isMac: boolean =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

/** The primary modifier: ⌘ on macOS, Ctrl on Windows. */
export function isModKey(e: Pick<KeyboardEvent, "metaKey" | "ctrlKey">, mac = isMac): boolean {
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/** `shortcutLabel("K")` -> `⌘K` / `Ctrl+K`; with shift -> `⇧⌘C` / `Ctrl+Shift+C`. */
export function shortcutLabel(key: string, opts: { shift?: boolean } = {}, mac = isMac): string {
  const k = key.toUpperCase();
  if (mac) return `${opts.shift ? "⇧" : ""}⌘${k}`;
  return `Ctrl+${opts.shift ? "Shift+" : ""}${k}`;
}

export const revealLabel = isMac ? "Reveal in Finder" : "Show in Explorer";

const EDITOR_SCHEMES: Record<Editor, string> = {
  vscode: "vscode",
  "vscode-insiders": "vscode-insiders",
  cursor: "cursor",
  windsurf: "windsurf",
};

export const EDITOR_NAMES: Record<Editor, string> = {
  vscode: "VS Code",
  "vscode-insiders": "VS Code Insiders",
  cursor: "Cursor",
  windsurf: "Windsurf",
};

/**
 * `vscode://file/<path>[:line]`. Windows paths use `/` (`vscode://file/C:/code/.env`); each
 * segment is percent-encoded so spaces and `#` survive.
 */
export function editorUrl(editor: Editor, path: string, line?: number): string {
  const slashed = path.replace(/\\/g, "/");
  const encoded = slashed
    .split("/")
    .map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
    .join("/");
  const withLead = encoded.startsWith("/") ? encoded : `/${encoded}`;
  return `${EDITOR_SCHEMES[editor]}://file${withLead}${line ? `:${line}` : ""}`;
}

function sepOf(path: string): string {
  return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

/** `~`-contracted path for display, keeping the path's own separator. */
export function displayPath(path: string, home: string | null | undefined): string {
  if (!home) return path;
  const sep = sepOf(path);
  const h = home.replace(/[\\/]+$/, "");
  const windows = sep === "\\" || /^[A-Za-z]:/.test(path);
  const same = (a: string, b: string) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (same(path, h)) return "~";
  const prefix = path.slice(0, h.length + 1);
  if (same(prefix, h + sep)) return `~${sep}${path.slice(h.length + 1)}`;
  return path;
}

/** Path of `path` relative to `base` (both native), or null if it isn't inside. */
export function relativeTo(path: string, base: string): string | null {
  const b = base.replace(/[\\/]+$/, "");
  if (path.length <= b.length + 1) return null;
  const sep = path[b.length];
  if (path.slice(0, b.length) !== b || (sep !== "/" && sep !== "\\")) return null;
  return path.slice(b.length + 1);
}

const rtf = typeof Intl !== "undefined" ? new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }) : null;

/** "5 minutes ago", "yesterday", or a date for anything older than a week. */
export function relativeTime(ms: number, now = Date.now()): string {
  const diff = Math.round((ms - now) / 1000);
  const abs = Math.abs(diff);
  if (!rtf) return new Date(ms).toLocaleString();
  if (abs < 45) return rtf.format(0, "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 7 * 86_400) return rtf.format(Math.round(diff / 86_400), "day");
  return new Date(ms).toLocaleDateString();
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Joins a native folder path and a file name with the folder's own separator. */
export function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.endsWith(sep) ? dir + name : `${dir}${sep}${name}`;
}

/** Parent folder of a native path. */
export function dirOf(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i > 0 ? path.slice(0, i) : path;
}
