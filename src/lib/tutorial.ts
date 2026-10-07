// First-run tutorial. Nothing about it is stored (AGENTS.md hard rule 1): "first run" is inferred
// from an empty manifest, and dismissing the tour is forgotten on quit.

import type { ManifestView } from "@/lib/ipc";

export type TutorialStepId = "welcome" | "library" | "folders" | "variables" | "push";

export const TUTORIAL_STEPS: readonly { id: TutorialStepId; title: string }[] = [
  { id: "welcome", title: "Welcome to EnvDeck" },
  { id: "library", title: "Choose a library" },
  { id: "folders", title: "Add your project folders" },
  { id: "variables", title: "Set variables" },
  { id: "push", title: "Push to GitHub or Azure" },
];

/**
 * True for a fresh start: the manifest loaded without error and has no folders and no library
 * (no `~/.envdeck.json` yet, or it was deleted). A broken config file never triggers the tour.
 */
export function shouldAutoShowTutorial(manifest: ManifestView | null): boolean {
  return !!manifest && !manifest.error && manifest.roots.length === 0 && !manifest.library;
}
