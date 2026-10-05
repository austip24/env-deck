// Mock-only port of envfile.rs (and kind detection from scan.rs) for `npm run dev:mock`.
// Good enough to drive the UI; Rust remains the real implementation. Only mock-ipc.ts imports
// this, so it never reaches the app bundle.

import type { EnvLine, EnvVar, FileKind, LineEnding, ParsedEnv, Quote } from "@/lib/ipc";

const TEMPLATE_WORDS = ["example", "sample", "template", "dist", "defaults"];

export const isDotenvName = (name: string) => {
  const n = name.toLowerCase();
  return n === ".env" || n.startsWith(".env.") || (n.endsWith(".env") && n.length > 4);
};
export const isTemplateName = (name: string) =>
  isDotenvName(name) && name.toLowerCase().split(".").some((s) => TEMPLATE_WORDS.includes(s));

export function kindOf(name: string): FileKind {
  const n = name.toLowerCase();
  if (isDotenvName(n)) return isTemplateName(n) ? "env-template" : "env";
  if (n === ".npmrc" || n === ".yarnrc") return "ini";
  const ext = n.includes(".") ? n.slice(n.lastIndexOf(".") + 1) : "";
  if (ext === "json" || ext === "jsonc") return "json";
  if (ext === "yml" || ext === "yaml") return "yaml";
  if (ext === "toml") return "toml";
  if (["ini", "cfg", "conf", "properties"].includes(ext)) return "ini";
  return "text";
}


interface RawLine {
  content: string;
  terminator: string;
}

function splitLines(text: string): RawLine[] {
  const out: RawLine[] = [];
  const re = /(.*?)(\r\n|\n|$)/gy;
  let m: RegExpExecArray | null;
  while (re.lastIndex < text.length && (m = re.exec(text))) {
    out.push({ content: m[1], terminator: m[2] });
  }
  return out;
}

export function detectEnding(text: string): LineEnding {
  const lf = (text.match(/\n/g) ?? []).length;
  const crlf = (text.match(/\r\n/g) ?? []).length;
  return crlf > lf - crlf ? "crlf" : "lf";
}

export const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function unescapeDouble(s: string): string {
  return s.replace(/\\(.)/g, (all, c: string) =>
    c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c === '"' ? '"' : c === "\\" ? "\\" : all,
  );
}

function findClose(s: string, q: string): number {
  for (let i = 0; i < s.length; i++) {
    if (q === '"' && s[i] === "\\") i++;
    else if (s[i] === q) return i;
  }
  return -1;
}

export function parseEnv(text: string): ParsedEnv {
  const raw = splitLines(text);
  const lines: EnvLine[] = [];
  for (let i = 0; i < raw.length; i++) {
    const n = i + 1;
    const content = raw[i].content;
    const other = (reason: string, end = n): EnvLine => ({ type: "other", startLine: n, endLine: end, raw: content, reason });
    const trimmed = content.replace(/^[ \t]+/, "");
    if (!trimmed.trim()) { lines.push({ type: "blank", line: n }); continue; }
    if (trimmed.startsWith("#")) { lines.push({ type: "comment", line: n, text: content }); continue; }
    let rest = trimmed;
    let exp = false;
    const ex = /^export[ \t]+/.exec(rest);
    if (ex) { exp = true; rest = rest.slice(ex[0].length); }
    const km = /^[A-Za-z0-9_.-]*/.exec(rest)![0];
    if (!KEY_RE.test(km)) { lines.push(other("expected KEY=value")); continue; }
    const afterKey = rest.slice(km.length).replace(/^[ \t]+/, "");
    if (!afterKey.startsWith("=")) { lines.push(other("missing '=' after the key")); continue; }
    const vp = afterKey.slice(1).replace(/^[ \t]+/, "");
    const q = vp[0];
    const quote: Quote = q === "'" ? "single" : q === '"' ? "double" : q === "`" ? "backtick" : "none";
    if (quote === "none") {
      // `KEY= # note`: whitespace then `#` is a comment, not the value.
      if (vp.startsWith("#") && vp.length < afterKey.length - 1) {
        lines.push({ type: "pair", key: km, value: "", quote, export: exp, startLine: n, endLine: n, inlineComment: vp.trim() });
        continue;
      }
      const hash = vp.search(/[ \t]#/);
      const value = (hash >= 0 ? vp.slice(0, hash) : vp).trimEnd();
      const inlineComment = hash >= 0 ? vp.slice(hash).trim() : null;
      lines.push({ type: "pair", key: km, value, quote, export: exp, startLine: n, endLine: n, inlineComment });
      continue;
    }
    let body = "";
    let seg = vp.slice(1);
    let j = i;
    let done = false;
    while (!done) {
      const close = findClose(seg, q);
      if (close >= 0) {
        body += seg.slice(0, close);
        const tail = seg.slice(close + 1).trim();
        if (tail && !tail.startsWith("#")) {
          lines.push(other("unexpected text after the closing quote", j + 1));
        } else {
          lines.push({
            type: "pair", key: km, value: quote === "double" ? unescapeDouble(body) : body, quote,
            export: exp, startLine: n, endLine: j + 1, inlineComment: tail || null,
          });
        }
        done = true;
      } else if (j + 1 >= raw.length) {
        lines.push(other("unterminated quoted value", j + 1));
        done = true;
      } else {
        body += seg + "\n";
        j++;
        seg = raw[j].content;
      }
    }
    i = j;
  }
  return { lines, lineEnding: detectEnding(text), trailingNewline: text.endsWith("\n") };
}

export function quoteValue(v: string): string {
  if (/^[A-Za-z0-9_./:@+,-]*$/.test(v)) return v;
  if (!/['\n\r]/.test(v)) return `'${v}'`;
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;
}

export function upsert(text: string, vars: EnvVar[]): string {
  const parsed = parseEnv(text);
  const bad = parsed.lines.find((l) => l.type === "other" && l.reason === "unterminated quoted value");
  if (bad && bad.type === "other") throw `Line ${bad.startLine} has an unterminated quote; fix it before writing to this file`;
  const ending = parsed.lineEnding === "crlf" ? "\r\n" : "\n";
  const raw = splitLines(text);
  const last = new Map<string, Extract<EnvLine, { type: "pair" }>>();
  for (const l of parsed.lines) if (l.type === "pair") last.set(l.key, l);
  const replace = new Map<number, { end: number; line: string }>();
  const appended = new Map<string, string>();
  for (const { key, value } of vars) {
    const p = last.get(key);
    if (p) {
      const line = `${p.export ? "export " : ""}${key}=${quoteValue(value)}${p.inlineComment ? " " + p.inlineComment : ""}`;
      replace.set(p.startLine - 1, { end: p.endLine - 1, line });
    } else appended.set(key, value);
  }
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const r = replace.get(i);
    if (r) { out += r.line + raw[r.end].terminator; i = r.end; } else out += raw[i].content + raw[i].terminator;
  }
  if (appended.size) {
    if (out && !out.endsWith("\n")) out += ending;
    for (const [k, v] of appended) out += `${k}=${quoteValue(v)}${ending}`;
  }
  return out;
}

export function templateTarget(name: string): string | null {
  if (!isTemplateName(name)) return null;
  const t = name.split(".").filter((s) => !TEMPLATE_WORDS.includes(s.toLowerCase())).join(".");
  const target = t.toLowerCase() === "env" ? ".env" : t;
  return isDotenvName(target) ? target : null;
}
