// In-app updates (update.rs). Nothing here is stored: a found update, and "Later", are
// forgotten on quit.

import type { UpdateProgress } from "@/lib/ipc";

/** Whole percent downloaded (0–100), or null when the size isn't known yet. */
export function progressPercent(p: UpdateProgress | null): number | null {
  if (!p || !p.total || p.total <= 0) return null;
  return Math.min(100, Math.max(0, Math.floor((p.downloaded / p.total) * 100)));
}

const mb = (bytes: number) => (bytes / 1_048_576).toFixed(1);

/** "3.2 of 12.0 MB", or "3.2 MB" without a known size. */
export function progressLabel(p: UpdateProgress | null): string {
  if (!p) return "Starting download…";
  return p.total ? `${mb(p.downloaded)} of ${mb(p.total)} MB` : `${mb(p.downloaded)} MB`;
}

/** The release's publish date as a short local date, or null if missing or unparseable. */
export function releaseDate(date: string | null, locale?: string): string | null {
  if (!date) return null;
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
}
