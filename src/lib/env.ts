// Pure dotenv helpers for the UI: secret detection, masking, compare and clipboard formats.
// No React, no IPC. Parsing itself happens in Rust (envfile.rs); this works on its output.

import type { EnvLine, EnvPair, ParsedEnv } from "@/lib/ipc";

export type Var = { key: string; value: string };

// --- secrets ----------------------------------------------------------------------------------

/** Key segments that mark a value as secret (`STRIPE_SECRET_KEY`, `dbPassword`, `API-TOKEN`). */
const SECRET_WORDS = new Set([
  "SECRET",
  "SECRETS",
  "TOKEN",
  "TOKENS",
  "PASSWORD",
  "PASSWD",
  "PWD",
  "PASS",
  "PASSPHRASE",
  "KEY",
  "APIKEY",
  "PRIVATE",
  "CREDENTIAL",
  "CREDENTIALS",
  "CREDS",
  "DSN",
  "AUTH",
  "COOKIE",
  "SALT",
  "SIGNATURE",
  "CERT",
]);

/** Splits `STRIPE_SECRET_KEY`, `stripe.secretKey`, `api-token` into upper-case words. */
function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split(/[_.\-\s]+/)
    .filter(Boolean)
    .map((w) => w.toUpperCase());
}

export function isSecretKey(key: string): boolean {
  return keyWords(key).some((w) => SECRET_WORDS.has(w));
}

/** URL with an embedded password, a PEM private key, or a connection string with a password. */
export function isSecretValue(value: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:[^/\s@]+@/i.test(value) ||
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(value) ||
    /(^|;)\s*(password|pwd)\s*=/i.test(value)
  );
}

export function isSecret(key: string, value: string): boolean {
  return value !== "" && (isSecretKey(key) || isSecretValue(value));
}

/** Fixed-width mask so the value's length isn't leaked. */
export const MASK = "••••••••";

// --- parsed lines -----------------------------------------------------------------------------

export type PairLine = Extract<EnvLine, { type: "pair" }>;

export function pairsOf(parsed: ParsedEnv): PairLine[] {
  return parsed.lines.filter((l): l is PairLine => l.type === "pair");
}

/** Effective variables: last definition wins, in order of first appearance. */
export function effectiveVars(parsed: ParsedEnv): Var[] {
  const out: Var[] = [];
  const index = new Map<string, number>();
  for (const p of pairsOf(parsed)) {
    const i = index.get(p.key);
    if (i === undefined) {
      index.set(p.key, out.length);
      out.push({ key: p.key, value: p.value });
    } else {
      out[i] = { key: p.key, value: p.value };
    }
  }
  return out;
}

/** Start lines of definitions that a later definition of the same key overrides. */
export function overriddenLines(parsed: ParsedEnv): Set<number> {
  const last = new Map<string, EnvPair>();
  const lines = new Set<number>();
  for (const p of pairsOf(parsed)) {
    const prev = last.get(p.key);
    if (prev) lines.add(prev.startLine);
    last.set(p.key, p);
  }
  return lines;
}

// --- compare ----------------------------------------------------------------------------------

export type CompareStatus = "same" | "differs" | "onlyA" | "onlyB";

export interface CompareRow {
  key: string;
  a: string | null;
  b: string | null;
  status: CompareStatus;
}

/** Key-by-key comparison: rows in `a`'s order, then keys only in `b`. */
export function compareEnv(a: Var[], b: Var[]): CompareRow[] {
  const bMap = new Map(b.map((v) => [v.key, v.value]));
  const aKeys = new Set(a.map((v) => v.key));
  const rows: CompareRow[] = a.map(({ key, value }) => {
    if (!bMap.has(key)) return { key, a: value, b: null, status: "onlyA" };
    const other = bMap.get(key)!;
    return { key, a: value, b: other, status: other === value ? "same" : "differs" };
  });
  for (const { key, value } of b) {
    if (!aKeys.has(key)) rows.push({ key, a: null, b: value, status: "onlyB" });
  }
  return rows;
}

// --- clipboard formats ------------------------------------------------------------------------

export type CopyFormat = "dotenv" | "export" | "powershell" | "cmd" | "json" | "docker";

export const COPY_FORMATS: { id: CopyFormat; label: string }[] = [
  { id: "dotenv", label: "KEY=value (.env)" },
  { id: "export", label: "export (bash/zsh)" },
  { id: "powershell", label: "$env: (PowerShell)" },
  { id: "cmd", label: "set (cmd.exe)" },
  { id: "json", label: "JSON object" },
  { id: "docker", label: "docker run -e flags" },
];

const BARE_SAFE = /^[A-Za-z0-9_./:@+,-]*$/;

/** dotenv quoting, mirroring `envfile::quote_value` in Rust. */
export function quoteDotenv(value: string): string {
  if (BARE_SAFE.test(value)) return value;
  if (!/['\n\r]/.test(value)) return `'${value}'`;
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

/** Characters a POSIX shell word can hold unquoted. */
const POSIX_SAFE = /^[A-Za-z0-9_./:@+,=-]+$/;

/** POSIX shell single-quoting: `it's` -> `'it'\''s'`. */
export function quotePosix(value: string): string {
  if (POSIX_SAFE.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** PowerShell single-quoted string: `it's` -> `'it''s'` (no `$` expansion). */
export function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const POSIX_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface Formatted {
  text: string;
  /** Problems the user should see before pasting (e.g. values a shell can't take as-is). */
  warnings: string[];
}

export function formatVars(vars: Var[], format: CopyFormat): Formatted {
  const warnings: string[] = [];
  const multiline = multilineKeys(vars);
  if (multiline.length && format !== "dotenv" && format !== "json") {
    warnings.push(`Multi-line values may not paste cleanly into a terminal: ${multiline.join(", ")}`);
  }
  const badNames = vars.filter((v) => !POSIX_NAME.test(v.key)).map((v) => v.key);

  switch (format) {
    case "dotenv":
      return { text: lines(vars.map((v) => `${v.key}=${quoteDotenv(v.value)}`)), warnings };

    case "json":
      return {
        text: JSON.stringify(Object.fromEntries(vars.map((v) => [v.key, v.value])), null, 2) + "\n",
        warnings,
      };

    case "export":
      if (badNames.length) warnings.push(`Not valid shell variable names: ${badNames.join(", ")}`);
      return { text: lines(vars.map((v) => `export ${v.key}=${quotePosix(v.value)}`)), warnings };

    case "docker":
      return {
        text: vars.map((v) => `-e ${quotePosix(`${v.key}=${v.value}`)}`).join(" ") + "\n",
        warnings,
      };

    case "powershell":
      return {
        text: lines(
          vars.map((v) => {
            const name = POSIX_NAME.test(v.key) ? `$env:${v.key}` : `\${env:${v.key}}`;
            return `${name} = ${quotePowerShell(v.value)}`;
          }),
        ),
        warnings,
      };

    case "cmd": {
      const unsafe = vars.filter((v) => /["%!]/.test(v.value)).map((v) => v.key);
      if (unsafe.length) {
        warnings.push(`cmd.exe may change values containing %, ! or ": ${unsafe.join(", ")}`);
      }
      return { text: lines(vars.map((v) => `set "${v.key}=${v.value}"`)), warnings };
    }
  }
}

/** Multi-line values that shell formats will split across lines. */
export function multilineKeys(vars: Var[]): string[] {
  return vars.filter((v) => /[\r\n]/.test(v.value)).map((v) => v.key);
}

function lines(ls: string[]): string {
  return ls.length ? ls.join("\n") + "\n" : "";
}

// --- masking in non-dotenv sources --------------------------------------------------------------

/** Character range of a secret value on one line of a JSON/YAML/TOML/INI file. */
export interface Span {
  start: number;
  end: number;
}

const JSON_PAIR = /^(\s*"((?:[^"\\]|\\.)*)"\s*:\s*")((?:[^"\\]|\\.)*)"/;
const YAML_PAIR = /^(\s*(?:-\s+)?([\w.$/@-]+)\s*:[ \t]+)(["']?)(.*?)\3(\s+#.*)?\s*$/;
const INI_PAIR = /^(\s*([^\s=:#;[][^=]*?)\s*=\s*)(["']?)(.*?)\3\s*$/;

/**
 * Finds a secret-looking value on a single line of a structured config file (best effort,
 * line by line): `"Password": "x"`, `token: x`, `api_key = "x"`, `//host/:_authToken=x`.
 */
export function secretSpanInLine(line: string, kind: "json" | "yaml" | "toml" | "ini" | "text"): Span | null {
  const tryMatch = (re: RegExp, keyGroup: number, quoteGroup: number | null, valueGroup: number): Span | null => {
    const m = re.exec(line);
    if (!m) return null;
    const key = m[keyGroup];
    const value = m[valueGroup];
    if (!value || !isSecret(key, value)) return null;
    const start = m[1].length + (quoteGroup !== null ? m[quoteGroup].length : 0);
    return { start, end: start + value.length };
  };
  switch (kind) {
    case "json":
      return tryMatch(JSON_PAIR, 2, null, 3);
    case "yaml":
      return tryMatch(YAML_PAIR, 2, 3, 4);
    case "toml":
    case "ini":
      return tryMatch(INI_PAIR, 2, 3, 4);
    case "text":
      return null;
  }
}

// --- writing helpers --------------------------------------------------------------------------

/** `.env`, `.env.*` and `*.env` (mirrors `envfile::is_dotenv_name`). */
export function isDotenvName(name: string): boolean {
  const n = name.toLowerCase();
  return n === ".env" || n.startsWith(".env.") || (n.endsWith(".env") && n.length > 4);
}

const TEMPLATE_WORDS = ["example", "sample", "template", "dist", "defaults"];

/** `.env.example` -> `.env`, `.env.local.sample` -> `.env.local` (mirrors `envfile::template_target`). */
export function templateTarget(name: string): string | null {
  if (!isDotenvName(name) || !name.toLowerCase().split(".").some((s) => TEMPLATE_WORDS.includes(s))) return null;
  const kept = name
    .split(".")
    .filter((s) => !TEMPLATE_WORDS.includes(s.toLowerCase()))
    .join(".");
  const target = kept.toLowerCase() === "env" ? ".env" : kept;
  return isDotenvName(target) ? target : null;
}

/** Backups and side-by-side copies EnvDeck makes: `.env.bak-1712345678`, `.env.copy`, `.env.copy-2`. */
export function isBackupName(name: string): boolean {
  return /\.(bak-\d+|copy)(-\d+)?$/i.test(name);
}

/** Converts the editor's `\n` text to the file's own line ending before saving. */
export function withLineEnding(text: string, ending: "lf" | "crlf"): string {
  const lf = text.replace(/\r\n/g, "\n");
  return ending === "crlf" ? lf.replace(/\n/g, "\r\n") : lf;
}

export interface SendPlan {
  add: Var[];
  replace: (Var & { previous: string })[];
  same: Var[];
}

/** What sending `vars` into a file with `target` variables would do. */
export function planSend(vars: Var[], target: Var[]): SendPlan {
  const existing = new Map(target.map((v) => [v.key, v.value]));
  const plan: SendPlan = { add: [], replace: [], same: [] };
  for (const v of vars) {
    if (!existing.has(v.key)) plan.add.push(v);
    else if (existing.get(v.key) === v.value) plan.same.push(v);
    else plan.replace.push({ ...v, previous: existing.get(v.key)! });
  }
  return plan;
}
