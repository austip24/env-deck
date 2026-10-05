import { useMemo } from "react";
import { isRevealed, type Reveal } from "@/components/env-table";
import { isSecret, MASK, secretSpanInLine } from "@/lib/env";
import type { ConfigContent } from "@/lib/ipc";
import { cn } from "@/lib/utils";

interface Rendered {
  text: string;
  /** The line didn't parse as dotenv. */
  invalid?: boolean;
  /** Hidden part of the line, if any (`end` past the line = mask to the end). */
  mask?: { start: number; end: number };
}

function physicalLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Lines with secret spans for non-dotenv files (JSON/YAML/TOML/INI, best effort per line). */
export function structuredSecretLines(content: ConfigContent): Map<number, { start: number; end: number }> {
  const spans = new Map<number, { start: number; end: number }>();
  if (content.env || content.kind === "env" || content.kind === "env-template") return spans;
  physicalLines(content.text).forEach((line, i) => {
    const s = secretSpanInLine(line, content.kind as "json" | "yaml" | "toml" | "ini" | "text");
    if (s) spans.set(i, s);
  });
  return spans;
}

/**
 * Raw text with line numbers. Secret values are masked until revealed: for dotenv files from
 * the parsed spans (never by regex on the raw text), for other config files line by line.
 */
export function SourceView({ content, reveal }: { content: ConfigContent; reveal: Reveal }) {
  const lines = useMemo<Rendered[]>(() => {
    const raw = physicalLines(content.text);
    const out: Rendered[] = raw.map((text) => ({ text }));

    if (content.env) {
      for (const l of content.env.lines) {
        if (l.type === "other") {
          for (let n = l.startLine; n <= l.endLine; n++) out[n - 1] = { ...out[n - 1], invalid: true };
        }
        if (l.type !== "pair" || !isSecret(l.key, l.value) || isRevealed(reveal, l.startLine)) continue;
        const first = raw[l.startLine - 1] ?? "";
        const eq = first.indexOf("=");
        const start = eq + 1 + (first.slice(eq + 1).match(/^[ \t]*/)?.[0].length ?? 0);
        const commentAt = l.inlineComment && l.endLine === l.startLine ? first.lastIndexOf(l.inlineComment) : -1;
        const end = commentAt > start ? first.slice(0, commentAt).trimEnd().length : Infinity;
        out[l.startLine - 1] = { text: first, mask: { start, end } };
        for (let n = l.startLine + 1; n <= l.endLine; n++) {
          out[n - 1] = { text: "", mask: { start: 0, end: Infinity } };
        }
      }
    } else if (!reveal.all) {
      for (const [i, span] of structuredSecretLines(content)) out[i] = { ...out[i], mask: span };
    }
    return out;
  }, [content, reveal]);

  const gutter = String(lines.length).length;

  return (
    <div className="font-mono text-[13px] leading-6">
      {lines.map((l, i) => (
        <div
          key={i}
          className={cn("flex", l.invalid ? "bg-warning/10" : "hover:bg-muted/40")}
          title={l.invalid ? "Not parsed as KEY=value" : undefined}
        >
          <span
            className="shrink-0 pr-4 pl-4 text-right text-muted-foreground/70 tabular-nums select-none"
            style={{ width: `${gutter + 3}ch` }}
          >
            {i + 1}
          </span>
          <span className="selectable min-w-0 flex-1 pr-4 break-all whitespace-pre-wrap">
            {l.mask ? (
              <>
                {l.text.slice(0, l.mask.start)}
                <span className="text-muted-foreground" aria-label="Hidden value">
                  {MASK}
                </span>
                {Number.isFinite(l.mask.end) && l.text.slice(l.mask.end)}
              </>
            ) : (
              l.text || "​"
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
