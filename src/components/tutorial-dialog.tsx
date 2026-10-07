import { useState, type ReactNode } from "react";
import {
  Check,
  Cloud,
  FolderOpen,
  FolderPlus,
  GitBranch,
  KeyRound,
  Library,
  Pencil,
  Settings2,
  SquarePen,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import type { Workspace } from "@/hooks/use-workspace";
import { shortcutLabel } from "@/lib/platform";
import { TUTORIAL_STEPS, type TutorialStepId } from "@/lib/tutorial";
import { cn } from "@/lib/utils";

const ICONS: Record<TutorialStepId, ReactNode> = {
  welcome: <KeyRound />,
  library: <Library />,
  folders: <FolderPlus />,
  variables: <SquarePen />,
  push: <Cloud />,
};

/** A step's "done" line, e.g. the library that was just picked. */
function Done({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 text-sm text-foreground">
      <Check className="size-4 shrink-0 text-success" />
      <span className="selectable min-w-0 truncate">{children}</span>
    </p>
  );
}

/**
 * The step-through tour: library, folders, setting variables, pushing to GitHub/Azure. The
 * library and folder steps open the native pickers (in Rust) through the workspace.
 */
export function TutorialDialog({
  open,
  onOpenChange,
  ws,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ws: Workspace;
}) {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  // Start from the first step each time the tour is opened.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setStep(0);
  }

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  const current = TUTORIAL_STEPS[step];
  const last = step === TUTORIAL_STEPS.length - 1;
  const library = ws.manifest?.library;
  const roots = ws.manifest?.roots ?? [];

  let body: ReactNode;
  switch (current.id) {
    case "welcome":
      body = (
        <>
          <p>
            EnvDeck finds the <code>.env</code> and config files already on your disk, including the ones git ignores,
            so you can compare, copy and edit them in one place.
          </p>
          <p>
            Secret values stay masked until you reveal them. Nothing is stored besides your own files and the list of
            folders in <code>~/.envdeck.json</code>.
          </p>
        </>
      );
      break;
    case "library":
      body = (
        <>
          <p>
            Your library is a folder of reusable configs and templates: shared <code>.env</code> files, a{" "}
            <code>.npmrc</code>, anything you copy into new projects. It shows at the bottom of the sidebar.
          </p>
          {library ? (
            <Done>{library.display}</Done>
          ) : (
            <Button variant="outline" disabled={busy} onClick={() => void run(ws.setLibrary)}>
              <Library /> Choose library folder…
            </Button>
          )}
          <p className="text-xs">
            Optional. You can change it later from the <Settings2 className="inline size-3.5 align-[-2px]" /> menu
            at the bottom of the sidebar.
          </p>
        </>
      );
      break;
    case "folders":
      body = (
        <>
          <p>
            Point EnvDeck at the folders where your projects live. It scans them for <code>.env</code> files, templates,{" "}
            <code>appsettings.json</code> and more, and keeps the list up to date as files change.
          </p>
          {roots.length > 0 && <Done>{roots.length === 1 ? roots[0].display : `${roots.length} folders`}</Done>}
          <div className="flex flex-wrap gap-2">
            <Button
              variant={roots.length ? "outline" : "default"}
              disabled={busy}
              onClick={() => void run(() => ws.addFolder(true))}
            >
              <FolderPlus /> {roots.length ? "Add another folder…" : "Add folder…"}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => void run(() => ws.addFolder(false))}>
              <FolderOpen /> Just this session…
            </Button>
          </div>
          <p className="text-xs">Saved folders are listed in ~/.envdeck.json. Session folders are forgotten on quit.</p>
        </>
      );
      break;
    case "variables":
      body = (
        <ul className="list-disc space-y-2 pl-5">
          <li>
            Pick a file in the sidebar. Press <Kbd>{shortcutLabel("K")}</Kbd> to filter.
          </li>
          <li>
            On the <strong className="font-medium text-foreground">Variables</strong> tab, double-click a value (or
            right-click › Edit value) to change it. Only that line is rewritten: comments, order and line endings stay
            as they were.
          </li>
          <li>
            To add new keys, click <Pencil className="inline size-3.5 align-[-2px]" />{" "}
            <strong className="font-medium text-foreground">Edit</strong> and change the source, then save with{" "}
            <Kbd>{shortcutLabel("S")}</Kbd>.
          </li>
          <li>Compare two files to spot and add missing keys, or copy a file into another project.</li>
        </ul>
      );
      break;
    case "push":
      body = (
        <>
          <p>From an open dotenv file, pick the keys to send:</p>
          <ul className="space-y-3">
            <li className="flex gap-2">
              <GitBranch className="mt-0.5 size-4 shrink-0 text-foreground" />
              <span>
                <strong className="font-medium text-foreground">Push to GitHub</strong> saves them as Actions secrets or
                variables, for the repo or an environment. It uses your own GitHub CLI login (
                <code>gh auth login</code>), and the project needs a GitHub <code>.git</code> remote.
              </span>
            </li>
            <li className="flex gap-2">
              <Cloud className="mt-0.5 size-4 shrink-0 text-foreground" />
              <span>
                <strong className="font-medium text-foreground">Push to Azure App Service</strong> merges them into an
                app's settings or connection strings. It uses your own Azure CLI login (<code>az login</code>).
              </span>
            </li>
          </ul>
          <p className="text-xs">
            EnvDeck never sees a token. Values go straight to the CLI, and existing settings are never deleted.
          </p>
        </>
      );
      break;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="select-none sm:max-w-md">
        <DialogHeader>
          <div className="mb-1 flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-5">
            {ICONS[current.id]}
          </div>
          <DialogTitle>{current.title}</DialogTitle>
          <DialogDescription>
            Step {step + 1} of {TUTORIAL_STEPS.length}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-48 flex-col items-start gap-3 text-sm text-muted-foreground">{body}</div>

        <DialogFooter className="items-center sm:justify-between">
          <div className="flex gap-1.5" aria-hidden>
            {TUTORIAL_STEPS.map((s, i) => (
              <span
                key={s.id}
                className={cn("size-1.5 rounded-full", i === step ? "bg-primary" : "bg-muted-foreground/30")}
              />
            ))}
          </div>
          <div className="flex gap-2">
            {!last && (
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Skip
              </Button>
            )}
            {step > 0 && (
              <Button variant="outline" onClick={() => setStep(step - 1)}>
                Back
              </Button>
            )}
            <Button onClick={() => (last ? onOpenChange(false) : setStep(step + 1))}>
              {last ? "Get started" : "Next"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
