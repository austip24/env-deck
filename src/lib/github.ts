// Pure helpers for "Push to GitHub": which keys can be pushed, where, and what they replace.
// No React, no IPC. The push itself runs `gh` from Rust (github.rs), which re-reads the values.

import type { Var } from "@/lib/env";
import type { GithubKind, GithubNames, GithubPushItem, GithubState } from "@/lib/ipc";

export interface PushRow {
  key: string;
  value: string;
  checked: boolean;
  kind: GithubKind;
  /** Environment name, or null for the repository. */
  target: string | null;
}

/** GitHub's rule for secret and variable names (mirrors `github::is_valid_name`). */
export function isValidGithubName(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !key.toUpperCase().startsWith("GITHUB_");
}

/** Why a key can't be pushed at all, or null. */
export function rowProblem(row: Pick<PushRow, "key" | "value">): string | null {
  if (!isValidGithubName(row.key)) return "GitHub names allow letters, digits and _ only, and not GITHUB_*";
  if (row.value === "") return "GitHub doesn't accept empty values";
  return null;
}

/**
 * One row per variable. Checked: the table selection when there is one, else everything.
 * Every row starts as a repository secret, the safe default (values stay write-only).
 */
export function initialRows(vars: Var[], selected: ReadonlySet<string>): PushRow[] {
  return vars.map((v) => ({
    key: v.key,
    value: v.value,
    checked: (selected.size === 0 || selected.has(v.key)) && rowProblem(v) === null,
    kind: "secret",
    target: null,
  }));
}

function namesFor(state: GithubState, target: string | null): GithubNames | undefined {
  return target === null ? state.repoNames : state.envNames[target];
}

/** Whether pushing the row adds a name or overwrites an existing one (GitHub can't show it). */
export function rowStatus(row: PushRow, state: GithubState): "new" | "replaces" {
  const names = namesFor(state, row.target);
  const list = row.kind === "secret" ? names?.secrets : names?.variables;
  return list?.includes(row.key) ? "replaces" : "new";
}

export function pushableRows(rows: PushRow[]): PushRow[] {
  return rows.filter((r) => r.checked && rowProblem(r) === null);
}

export function summarize(rows: PushRow[], state: GithubState): { count: number; replace: number } {
  const ready = pushableRows(rows);
  return { count: ready.length, replace: ready.filter((r) => rowStatus(r, state) === "replaces").length };
}

export function toPushItems(rows: PushRow[]): GithubPushItem[] {
  return pushableRows(rows).map((r) => ({ key: r.key, kind: r.kind, environment: r.target }));
}

/** "production" or "Repository", for labels. */
export function targetLabel(target: string | null): string {
  return target ?? "Repository";
}
