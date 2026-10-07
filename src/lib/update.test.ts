import { describe, expect, it } from "vitest";
import { progressLabel, progressPercent, releaseDate } from "./update";

describe("progressPercent", () => {
  it("is null until the size is known", () => {
    expect(progressPercent(null)).toBeNull();
    expect(progressPercent({ downloaded: 10, total: null })).toBeNull();
    expect(progressPercent({ downloaded: 10, total: 0 })).toBeNull();
  });

  it("rounds down and clamps", () => {
    expect(progressPercent({ downloaded: 0, total: 200 })).toBe(0);
    expect(progressPercent({ downloaded: 199, total: 200 })).toBe(99);
    expect(progressPercent({ downloaded: 200, total: 200 })).toBe(100);
    expect(progressPercent({ downloaded: 300, total: 200 })).toBe(100);
  });
});

describe("progressLabel", () => {
  it("shows megabytes with and without a total", () => {
    expect(progressLabel(null)).toBe("Starting download…");
    expect(progressLabel({ downloaded: 3_355_443, total: 12_582_912 })).toBe("3.2 of 12.0 MB");
    expect(progressLabel({ downloaded: 1_048_576, total: null })).toBe("1.0 MB");
  });
});

describe("releaseDate", () => {
  it("formats valid dates and drops the rest", () => {
    expect(releaseDate("2026-10-06T12:00:00Z", "en-US")).toBe("Oct 6, 2026");
    expect(releaseDate(null)).toBeNull();
    expect(releaseDate("not a date")).toBeNull();
  });
});
