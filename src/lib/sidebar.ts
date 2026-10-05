// Sidebar width rules. Width and collapsed state live in React state only (no storage): they
// reset to the defaults on every launch.

export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 520;
export const SIDEBAR_DEFAULT = 288;
/** Dragging narrower than this collapses the sidebar to the rail. */
export const COLLAPSE_SNAP = 140;
/** The main pane keeps at least this much room. */
export const MAIN_MIN = 360;

/** Clamps to [SIDEBAR_MIN, SIDEBAR_MAX], and below `windowWidth - MAIN_MIN` when that's smaller. */
export function clampSidebarWidth(width: number, windowWidth = Infinity): number {
  const max = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, windowWidth - MAIN_MIN));
  return Math.round(Math.min(max, Math.max(SIDEBAR_MIN, width)));
}

/** Where a drag of the resize handle to `width` lands: a clamped width, or collapsed. */
export function resolveDrag(width: number, windowWidth = Infinity): { width: number; collapsed: boolean } {
  if (width < COLLAPSE_SNAP) return { width: SIDEBAR_MIN, collapsed: true };
  return { width: clampSidebarWidth(width, windowWidth), collapsed: false };
}
