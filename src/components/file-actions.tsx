import { useEffect } from "react";
import { ClipboardCopy, Copy, Ellipsis, ExternalLink, GitBranch, GripVertical, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { CopyActions } from "@/hooks/use-copy";
import { COPY_FORMATS, type Var } from "@/lib/env";
import type { ConfigContent, ConfigFile, GithubRepoInfo } from "@/lib/ipc";
import { isMac, isModKey, shortcutLabel } from "@/lib/platform";

/**
 * Header actions for the open file, plus their shortcuts: ⇧C copy contents, ⇧F copy file,
 * E open in editor (with ⌘ on macOS, Ctrl on Windows).
 */
export function FileActions({
  content,
  file,
  vars,
  selectedCount,
  copy,
  editing,
  onEdit,
  onCopyTo,
  onSendTo,
  onPushToGithub,
  githubRepo,
  githubUnavailable,
}: {
  content: ConfigContent;
  file: ConfigFile | undefined;
  /** Variables "Copy as" uses: the selection, or all when nothing is selected. */
  vars: Var[] | null;
  selectedCount: number;
  copy: CopyActions;
  editing: boolean;
  onEdit: () => void;
  onCopyTo: () => void;
  onSendTo: () => void;
  onPushToGithub: () => void;
  /** The GitHub repository next to the file, once detected. */
  githubRepo: GithubRepoInfo | null;
  /** Why "Push to GitHub" isn't available (e.g. no .git next to the file). */
  githubUnavailable: string | null;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isModKey(e) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (e.shiftKey && key === "c") {
        e.preventDefault();
        void copy.copyContents(content.text, content.name);
      } else if (e.shiftKey && key === "f") {
        e.preventDefault();
        void copy.copyFile(content.path);
      } else if (!e.shiftKey && key === "e") {
        e.preventDefault();
        void copy.openInEditor(content.path);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [content, copy]);

  return (
    <div className="flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Drag file out"
            className="cursor-grab active:cursor-grabbing"
            onPointerDown={(e) => {
              if (e.button === 0) copy.startDrag(content.path);
            }}
          >
            <GripVertical />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Drag into {isMac ? "Finder" : "Explorer"} or the VS Code explorer</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="sm" onClick={() => void copy.copyContents(content.text, content.name)}>
            <Copy /> Copy
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          Copy contents <Kbd>{shortcutLabel("C", { shift: true })}</Kbd>
        </TooltipContent>
      </Tooltip>

      {vars && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <ClipboardCopy /> Copy as
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              {selectedCount > 0
                ? `${selectedCount} selected ${selectedCount === 1 ? "variable" : "variables"}`
                : `All ${vars.length} ${vars.length === 1 ? "variable" : "variables"}`}
            </DropdownMenuLabel>
            {COPY_FORMATS.map((f) => (
              <DropdownMenuItem key={f.id} onSelect={() => void copy.copyVarsAs(vars, f.id)}>
                {f.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onSendTo} disabled={vars.length === 0}>
              Send to another .env file…
            </DropdownMenuItem>
            {githubRepo && (
              <DropdownMenuItem onSelect={onPushToGithub} disabled={vars.length === 0}>
                Push to GitHub secrets/variables…
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {vars && (
        <Tooltip>
          <TooltipTrigger asChild>
            {/* A span so the tooltip still shows when the button is disabled. */}
            <span tabIndex={githubRepo ? -1 : 0}>
              <Button
                variant="outline"
                size="sm"
                onClick={onPushToGithub}
                disabled={!githubRepo || vars.length === 0 || editing}
              >
                <GitBranch /> GitHub
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-72">
            {githubRepo
              ? `Push ${selectedCount > 0 ? "selected" : "all"} keys to ${githubRepo.remotes[0].owner}/${githubRepo.remotes[0].name} as Actions secrets or variables`
              : githubUnavailable
                ? `Push to GitHub needs a .git folder next to this file. ${githubUnavailable}`
                : "Looking for a GitHub repository next to this file…"}
          </TooltipContent>
        </Tooltip>
      )}

      <Button variant="outline" size="sm" onClick={onEdit} disabled={editing}>
        <Pencil /> Edit
      </Button>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Open in ${copy.editorName}`}
            onClick={() => void copy.openInEditor(content.path)}
          >
            <ExternalLink />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          Open in {copy.editorName} <Kbd>{shortcutLabel("E")}</Kbd>
        </TooltipContent>
      </Tooltip>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="More actions">
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onCopyTo}>Copy to…</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void copy.copyFile(content.path)}>
            Copy file
            <DropdownMenuShortcut>{shortcutLabel("F", { shift: true })}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void copy.copyPath(content.path)}>Copy path</DropdownMenuItem>
          {file && (
            <DropdownMenuItem onSelect={() => void copy.copyText(file.relPath, "relative path")}>
              Copy relative path
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void copy.reveal(content.path)}>
            {copy.revealLabel}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
