import { describe, expect, it } from "vitest";
import { errorCode, errorText } from "./ipc";

describe("errorText / errorCode", () => {
  it("strips the code prefix Rust adds", () => {
    const e = "STALE: /a/.env changed on disk since it was loaded. Reload it first.";
    expect(errorCode(e)).toBe("STALE");
    expect(errorText(e)).toBe("/a/.env changed on disk since it was loaded. Reload it first.");
    expect(errorCode("EXISTS: /a/.env already exists")).toBe("EXISTS");
  });

  it("recognises the GitHub codes", () => {
    const e = "GH_AUTH: Your GitHub sign-in expired. Sign in again.";
    expect(errorCode(e)).toBe("GH_AUTH");
    expect(errorText(e)).toBe("Your GitHub sign-in expired. Sign in again.");
    expect(errorCode("GH_MISSING: The GitHub CLI (gh) isn't installed")).toBe("GH_MISSING");
    expect(errorCode("NO_REPO: /a has no .git folder")).toBe("NO_REPO");
    expect(errorCode("GH_NOT_INSTALLED: EnvDeck isn't installed on acme/shop.")).toBe("GH_NOT_INSTALLED");
  });

  it("passes other errors through", () => {
    expect(errorCode("/a isn't UTF-8 text")).toBeNull();
    expect(errorText("/a isn't UTF-8 text")).toBe("/a isn't UTF-8 text");
    expect(errorText(new Error("boom"))).toBe("boom");
    expect(errorText(42)).toBe("42");
    // Only a leading code counts.
    expect(errorCode("note: STALE: x")).toBeNull();
  });
});
