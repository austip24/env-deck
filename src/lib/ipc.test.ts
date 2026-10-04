import { describe, expect, it } from "vitest";
import { errorCode, errorText } from "./ipc";

describe("errorText / errorCode", () => {
  it("strips the code prefix Rust adds", () => {
    const e = "STALE: /a/.env changed on disk since it was loaded. Reload it first.";
    expect(errorCode(e)).toBe("STALE");
    expect(errorText(e)).toBe("/a/.env changed on disk since it was loaded. Reload it first.");
    expect(errorCode("EXISTS: /a/.env already exists")).toBe("EXISTS");
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
