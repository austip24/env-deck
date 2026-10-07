import { describe, expect, it } from "vitest";
import { crossPromptFor } from "./cross-push";

describe("crossPromptFor", () => {
  it("offers the other service with the pushed keys", () => {
    expect(crossPromptFor("github", ["A", "B", "A"], true, false)).toEqual({ to: "azure", keys: ["A", "B"] });
    expect(crossPromptFor("azure", ["A"], true, false)).toEqual({ to: "github", keys: ["A"] });
  });

  it("offers Azure without a repo, but GitHub only with one", () => {
    expect(crossPromptFor("github", ["A"], false, false)?.to).toBe("azure");
    expect(crossPromptFor("azure", ["A"], false, false)).toBeNull();
  });

  it("stays quiet when nothing was pushed or the push came from a prompt", () => {
    expect(crossPromptFor("github", [], true, false)).toBeNull();
    expect(crossPromptFor("github", ["A"], true, true)).toBeNull();
    expect(crossPromptFor("azure", ["A"], true, true)).toBeNull();
  });
});
