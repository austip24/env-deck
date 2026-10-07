import { describe, expect, it } from "vitest";
import { shouldAutoShowTutorial, TUTORIAL_STEPS } from "./tutorial";
import type { ManifestView } from "./ipc";

const manifest = (over: Partial<ManifestView> = {}): ManifestView => ({
  configPath: "/Users/dev/.envdeck.json",
  configDisplay: "~/.envdeck.json",
  home: "/Users/dev",
  roots: [],
  library: null,
  settings: { include: [], excludeDirs: [], maxDepth: 8, maxFileBytes: 524_288, editor: "vscode" },
  warnings: [],
  error: null,
  ...over,
});

const folder = { path: "/Users/dev/code", display: "~/code", saved: true };

describe("shouldAutoShowTutorial", () => {
  it("waits for the manifest", () => {
    expect(shouldAutoShowTutorial(null)).toBe(false);
  });

  it("shows on a fresh start", () => {
    expect(shouldAutoShowTutorial(manifest())).toBe(true);
  });

  it("stays hidden once there are folders or a library", () => {
    expect(shouldAutoShowTutorial(manifest({ roots: [folder] }))).toBe(false);
    expect(shouldAutoShowTutorial(manifest({ roots: [{ ...folder, saved: false }] }))).toBe(false);
    expect(shouldAutoShowTutorial(manifest({ library: folder }))).toBe(false);
  });

  it("stays hidden when the config file is broken", () => {
    expect(shouldAutoShowTutorial(manifest({ error: "expected value at line 1" }))).toBe(false);
  });
});

describe("TUTORIAL_STEPS", () => {
  it("goes library, folders, variables, push", () => {
    expect(TUTORIAL_STEPS.map((s) => s.id)).toEqual(["welcome", "library", "folders", "variables", "push"]);
  });
});
