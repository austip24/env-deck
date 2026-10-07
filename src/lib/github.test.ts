import { describe, expect, it } from "vitest";
import {
  initialRows,
  isValidGithubName,
  rowProblem,
  rowStatus,
  summarize,
  toPushItems,
  type PushRow,
} from "./github";
import type { GithubState } from "./ipc";

const state: GithubState = {
  repo: "acme/shop",
  login: "octocat",
  environments: ["production", "staging"],
  repoNames: { secrets: ["API_KEY"], variables: ["LOG_LEVEL"] },
  envNames: {
    production: { secrets: ["DB_URL"], variables: [] },
    staging: { secrets: [], variables: ["API_KEY"] },
  },
  warnings: [],
};

const vars = [
  { key: "API_KEY", value: "sk_1" },
  { key: "LOG_LEVEL", value: "debug" },
  { key: "DB_URL", value: "postgres://x" },
  { key: "EMPTY", value: "" },
  { key: "app.name", value: "shop" },
];

describe("names", () => {
  it("follows GitHub's naming rules", () => {
    for (const ok of ["API_KEY", "_x", "a1"]) expect(isValidGithubName(ok)).toBe(true);
    for (const bad of ["", "1A", "A-B", "app.name", "GITHUB_TOKEN", "github_x"]) {
      expect(isValidGithubName(bad)).toBe(false);
    }
  });

  it("explains rows that can't be pushed", () => {
    expect(rowProblem({ key: "API_KEY", value: "x" })).toBeNull();
    expect(rowProblem({ key: "app.name", value: "x" })).toMatch(/letters/);
    expect(rowProblem({ key: "EMPTY", value: "" })).toMatch(/empty/);
  });
});

describe("rows", () => {
  it("checks everything pushable as repository secrets by default", () => {
    const rows = initialRows(vars, new Set());
    expect(rows.map((r) => r.checked)).toEqual([true, true, true, false, false]);
    expect(rows.every((r) => r.kind === "secret" && r.target === null)).toBe(true);
  });

  it("checks only the table selection when there is one", () => {
    const rows = initialRows(vars, new Set(["DB_URL", "EMPTY"]));
    expect(rows.filter((r) => r.checked).map((r) => r.key)).toEqual(["DB_URL"]);
  });

  it("works out what each row replaces per kind and target", () => {
    const row = (key: string, kind: PushRow["kind"], target: string | null): PushRow => ({
      key,
      value: "v",
      checked: true,
      kind,
      target,
    });
    expect(rowStatus(row("API_KEY", "secret", null), state)).toBe("replaces");
    expect(rowStatus(row("API_KEY", "variable", null), state)).toBe("new");
    expect(rowStatus(row("API_KEY", "variable", "staging"), state)).toBe("replaces");
    expect(rowStatus(row("DB_URL", "secret", "production"), state)).toBe("replaces");
    expect(rowStatus(row("DB_URL", "secret", "staging"), state)).toBe("new");
    expect(rowStatus(row("DB_URL", "secret", "preview"), state)).toBe("new");
  });

  it("summarises and builds push items", () => {
    const rows = initialRows(vars, new Set());
    rows[1] = { ...rows[1], kind: "variable" };
    rows[2] = { ...rows[2], target: "staging" };
    rows[3] = { ...rows[3], checked: true }; // still unpushable: empty value
    expect(summarize(rows, state)).toEqual({ count: 3, replace: 2 });
    expect(toPushItems(rows)).toEqual([
      { key: "API_KEY", kind: "secret", environment: null },
      { key: "LOG_LEVEL", kind: "variable", environment: null },
      { key: "DB_URL", kind: "secret", environment: "staging" },
    ]);
  });
});
