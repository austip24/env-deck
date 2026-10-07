// After a push to GitHub or Azure App Service, EnvDeck offers to push the same keys to the other
// one. Pure logic; the prompt lives in file-view.tsx. Nothing here is remembered.

export type PushService = "github" | "azure";

export interface CrossPrompt {
  to: PushService;
  /** The keys that were pushed successfully, in order, without repeats. */
  keys: string[];
}

export const SERVICE_LABELS: Record<PushService, string> = {
  github: "GitHub",
  azure: "Azure App Service",
};

/**
 * The prompt to show once the `from` dialog closes, or null: nothing was pushed, GitHub isn't
 * available for this file, or the push was itself started from a prompt (never ping-pong).
 */
export function crossPromptFor(
  from: PushService,
  pushedKeys: string[],
  githubAvailable: boolean,
  chained: boolean,
): CrossPrompt | null {
  if (chained || pushedKeys.length === 0) return null;
  const to: PushService = from === "github" ? "azure" : "github";
  if (to === "github" && !githubAvailable) return null;
  return { to, keys: [...new Set(pushedKeys)] };
}
