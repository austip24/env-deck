import type { ReactNode } from "react";
import { FolderOpen, FolderPlus, KeyRound, MousePointerClick } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { shortcutLabel } from "@/lib/platform";

function Frame({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-6">
        {icon}
      </div>
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="max-w-sm text-sm text-muted-foreground">{children}</div>
    </div>
  );
}

/** No folders yet: explain what EnvDeck does and offer both ways to add one. */
export function NoFolders({ onAdd, onShowTutorial }: { onAdd: (persist: boolean) => void; onShowTutorial: () => void }) {
  return (
    <Frame icon={<KeyRound />} title="Find your .env and config files">
      <p>
        Point EnvDeck at the folder where your projects live. It finds <code>.env</code> files, templates,{" "}
        <code>.npmrc</code>, <code>appsettings.json</code> and more, including the ones git ignores.
      </p>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        <Button onClick={() => onAdd(true)}>
          <FolderPlus /> Add folder…
        </Button>
        <Button variant="outline" onClick={() => onAdd(false)}>
          <FolderOpen /> Open for this session…
        </Button>
      </div>
      <p className="mt-3 text-xs">Saved folders are listed in ~/.envdeck.json. Session folders aren't saved anywhere.</p>
      <Button variant="link" size="sm" className="mt-1" onClick={onShowTutorial}>
        New here? Take the tour
      </Button>
    </Frame>
  );
}

export function NoSelection({ fileCount }: { fileCount: number }) {
  return (
    <Frame icon={<MousePointerClick />} title={fileCount ? "Select a file" : "No config files found"}>
      {fileCount ? (
        <p>
          Pick a file on the left, or press <Kbd>{shortcutLabel("K")}</Kbd> to filter.
        </p>
      ) : (
        <p>
          Nothing matched in the scanned folders. Press <Kbd>{shortcutLabel("R")}</Kbd> to rescan.
        </p>
      )}
    </Frame>
  );
}
