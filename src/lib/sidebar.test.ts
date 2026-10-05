import { describe, expect, it } from "vitest";
import { clampSidebarWidth, COLLAPSE_SNAP, MAIN_MIN, resolveDrag, SIDEBAR_MAX, SIDEBAR_MIN } from "./sidebar";

describe("clampSidebarWidth", () => {
  it("keeps widths inside the bounds", () => {
    expect(clampSidebarWidth(300)).toBe(300);
    expect(clampSidebarWidth(50)).toBe(SIDEBAR_MIN);
    expect(clampSidebarWidth(2000)).toBe(SIDEBAR_MAX);
  });

  it("rounds fractional pointer positions", () => {
    expect(clampSidebarWidth(300.6)).toBe(301);
  });

  it("leaves room for the main pane in a narrow window", () => {
    expect(clampSidebarWidth(500, 700)).toBe(700 - MAIN_MIN);
  });

  it("never goes below the minimum, even in a tiny window", () => {
    expect(clampSidebarWidth(500, 300)).toBe(SIDEBAR_MIN);
  });
});

describe("resolveDrag", () => {
  it("collapses below the snap threshold", () => {
    expect(resolveDrag(COLLAPSE_SNAP - 1).collapsed).toBe(true);
  });

  it("clamps between the snap threshold and the minimum instead of collapsing", () => {
    expect(resolveDrag(COLLAPSE_SNAP)).toEqual({ width: SIDEBAR_MIN, collapsed: false });
  });

  it("passes the window width through", () => {
    expect(resolveDrag(600, 800)).toEqual({ width: 800 - MAIN_MIN, collapsed: false });
  });
});
