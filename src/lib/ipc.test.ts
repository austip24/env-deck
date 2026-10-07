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
    const e = "GH_AUTH: The GitHub CLI isn't signed in to GitHub. Run gh auth login in a terminal, then try again.";
    expect(errorCode(e)).toBe("GH_AUTH");
    expect(errorText(e)).toBe("The GitHub CLI isn't signed in to GitHub. Run gh auth login in a terminal, then try again.");
    expect(errorCode("GH_MISSING: The GitHub CLI (gh) isn't installed")).toBe("GH_MISSING");
    expect(errorCode("NO_REPO: /a has no .git folder")).toBe("NO_REPO");
    // Codes from the removed GitHub App sign-in are no longer recognised.
    expect(errorCode("GH_NOT_INSTALLED: EnvDeck isn't installed on acme/shop.")).toBeNull();
    expect(errorCode("GH_NO_CLIENT: not set up")).toBeNull();
  });

  it("recognises the Azure codes", () => {
    const e = "AZ_AUTH: The Azure CLI isn't signed in, or its sign-in expired. Run az login in a terminal, then try again.";
    expect(errorCode(e)).toBe("AZ_AUTH");
    expect(errorText(e)).toMatch(/^The Azure CLI isn't signed in/);
    expect(errorCode("AZ_MISSING: The Azure CLI (az) isn't installed or couldn't be found")).toBe("AZ_MISSING");
  });

  it("recognises the update code", () => {
    expect(errorCode("NO_UPDATE: Check for updates first")).toBe("NO_UPDATE");
    expect(errorText("NO_UPDATE: Check for updates first")).toBe("Check for updates first");
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
