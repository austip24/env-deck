import { describe, expect, it } from "vitest";
import { dirOf, displayPath, editorUrl, formatBytes, isModKey, joinPath, relativeTo, shortcutLabel } from "./platform";

describe("shortcuts", () => {
  it("labels per OS", () => {
    expect(shortcutLabel("k", {}, true)).toBe("⌘K");
    expect(shortcutLabel("c", { shift: true }, true)).toBe("⇧⌘C");
    expect(shortcutLabel("k", {}, false)).toBe("Ctrl+K");
    expect(shortcutLabel("c", { shift: true }, false)).toBe("Ctrl+Shift+C");
  });

  it("uses ⌘ on macOS and Ctrl on Windows", () => {
    expect(isModKey({ metaKey: true, ctrlKey: false }, true)).toBe(true);
    expect(isModKey({ metaKey: false, ctrlKey: true }, true)).toBe(false);
    expect(isModKey({ metaKey: false, ctrlKey: true }, false)).toBe(true);
    expect(isModKey({ metaKey: true, ctrlKey: false }, false)).toBe(false);
  });
});

describe("editorUrl", () => {
  it("builds macOS URLs", () => {
    expect(editorUrl("vscode", "/Users/dev/code/.env")).toBe("vscode://file/Users/dev/code/.env");
    expect(editorUrl("cursor", "/Users/dev/my app/#1/.env", 3)).toBe(
      "cursor://file/Users/dev/my%20app/%231/.env:3",
    );
  });

  it("builds Windows URLs with forward slashes and the drive letter intact", () => {
    expect(editorUrl("vscode", "C:\\code\\api\\.env")).toBe("vscode://file/C:/code/api/.env");
    expect(editorUrl("vscode-insiders", "D:\\work\\a b\\.env")).toBe("vscode-insiders://file/D:/work/a%20b/.env");
  });
});

describe("displayPath", () => {
  it("contracts home on macOS", () => {
    expect(displayPath("/Users/dev/code/.env", "/Users/dev")).toBe("~/code/.env");
    expect(displayPath("/Users/dev", "/Users/dev")).toBe("~");
    expect(displayPath("/Users/dev2/x", "/Users/dev")).toBe("/Users/dev2/x");
  });

  it("contracts home on Windows, case-insensitively, keeping backslashes", () => {
    expect(displayPath("C:\\Users\\dev\\code\\.env", "C:\\Users\\dev")).toBe("~\\code\\.env");
    expect(displayPath("c:\\users\\DEV\\x", "C:\\Users\\dev")).toBe("~\\x");
    expect(displayPath("D:\\work\\.env", "C:\\Users\\dev")).toBe("D:\\work\\.env");
  });

  it("passes through without a home", () => {
    expect(displayPath("/a/b", null)).toBe("/a/b");
  });
});

describe("relativeTo", () => {
  it("handles both separators and rejects siblings", () => {
    expect(relativeTo("/a/b/c", "/a")).toBe("b/c");
    expect(relativeTo("C:\\a\\b", "C:\\a")).toBe("b");
    expect(relativeTo("/ab/c", "/a")).toBeNull();
    expect(relativeTo("/a", "/a")).toBeNull();
  });
});

it("formatBytes", () => {
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(2048)).toBe("2.0 KB");
});

it("joinPath and dirOf keep the native separator", () => {
  expect(joinPath("C:\\code\\api", ".env")).toBe("C:\\code\\api\\.env");
  expect(joinPath("/Users/dev/code/", ".env")).toBe("/Users/dev/code/.env");
  expect(dirOf("C:\\code\\api\\.env")).toBe("C:\\code\\api");
  expect(dirOf("/Users/dev/.env")).toBe("/Users/dev");
});
