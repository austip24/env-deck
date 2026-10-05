import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import {
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Ellipsis,
  Folder,
  FolderPlus,
  Library,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
  Settings2,
  TriangleAlert,
} from "lucide-react";
import { FileIcon } from "@/components/file-icon";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { CopyActions } from "@/hooks/use-copy";
import type { Workspace } from "@/hooks/use-workspace";
import type { ConfigFile, RootStatus } from "@/lib/ipc";
import { shortcutLabel } from "@/lib/platform";
import { clampSidebarWidth, resolveDrag, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN } from "@/lib/sidebar";
import { cn } from "@/lib/utils";

interface ProjectGroup {
  key: string;
  name: string;
  relPath: string;
  files: ConfigFile[];
}

interface RootGroup {
  status: RootStatus;
  projects: ProjectGroup[];
}

/** A folder or the library, pending the "remove?" confirmation. */
interface RemoveTarget {
  path: string;
  display: string;
  library: boolean;
}

// Collapse keys are namespaced: a root folder can also be a project with the same path.
const rootKey = (path: string) => `root:${path}`;
const projectKey = (path: string) => `project:${path}`;

function matches(file: ConfigFile, tokens: string[]): boolean {
  const hay = `${file.projectName} ${file.projectRelPath} ${file.relPath}`.toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

function groupFiles(roots: RootStatus[], files: ConfigFile[], tokens: string[]): RootGroup[] {
  return roots.map((status) => {
    const projects = new Map<string, ProjectGroup>();
    for (const f of files) {
      if (f.root !== status.path || !matches(f, tokens)) continue;
      let g = projects.get(f.project);
      if (!g) {
        g = { key: f.project, name: f.projectName, relPath: f.projectRelPath, files: [] };
        projects.set(f.project, g);
      }
      g.files.push(f);
    }
    return { status, projects: [...projects.values()] };
  });
}

export function Sidebar({
  ws,
  copy,
  onSelect,
  width,
  onWidthChange,
  collapsed: railOnly,
  onCollapsedChange,
  filterRequest,
  onFocusFilter,
}: {
  ws: Workspace;
  copy: CopyActions;
  /** Opens a file (the app may first confirm discarding unsaved edits). */
  onSelect: (path: string) => void;
  width: number;
  onWidthChange: (width: number) => void;
  /** Shrunk to the icon rail. */
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  /** Bumped by the app (⌘/Ctrl+K) to focus the filter once the full sidebar is showing. */
  filterRequest: number;
  onFocusFilter: () => void;
}) {
  const filterRef = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState("");
  // Collapse state lives here, so it survives switching to the rail and back.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [removing, setRemoving] = useState<RemoveTarget | null>(null);
  const tokens = useMemo(() => filter.toLowerCase().split(/\s+/).filter(Boolean), [filter]);

  useEffect(() => {
    if (filterRequest === 0) return;
    filterRef.current?.focus();
    filterRef.current?.select();
  }, [filterRequest]);

  const groups = useMemo(
    () => (ws.scan ? groupFiles(ws.scan.roots, ws.scan.files, tokens) : []),
    [ws.scan, tokens],
  );
  const allKeys = useMemo(() => {
    if (!ws.scan) return [];
    const keys = new Set(ws.scan.roots.map((r) => rootKey(r.path)));
    for (const f of ws.scan.files) keys.add(projectKey(f.project));
    return [...keys];
  }, [ws.scan]);
  const anyOpen = allKeys.some((k) => !collapsed.has(k));
  const folders = groups.filter((g) => !g.status.library);
  const library = groups.find((g) => g.status.library);
  const matchCount = groups.reduce((n, g) => n + g.projects.reduce((m, p) => m + p.files.length, 0), 0);
  const warnings = [...(ws.manifest?.warnings ?? []), ...(ws.scan?.warnings ?? [])];

  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Saved folders and the library are written to ~/.envdeck.json, so ask first; session
  // folders just close.
  const requestRemove = (target: RemoveTarget & { saved: boolean }) => {
    if (target.library || target.saved) setRemoving(target);
    else void ws.removeFolder(target.path);
  };

  const renderRoot = (group: RootGroup) => (
    <RootSection
      key={group.status.path}
      group={group}
      ws={ws}
      copy={copy}
      onSelect={onSelect}
      filtering={tokens.length > 0}
      collapsed={collapsed}
      onToggle={toggle}
      onRemove={() => requestRemove(group.status)}
    />
  );

  const removeDialog = (
    <Dialog open={removing !== null} onOpenChange={(o) => !o && setRemoving(null)}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{removing?.library ? "Remove library?" : "Remove saved folder?"}</DialogTitle>
          <DialogDescription>
            EnvDeck will stop showing <span className="selectable font-medium text-foreground">{removing?.display}</span>
            {removing?.library ? " as the library" : ""}. Files on disk aren't deleted.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setRemoving(null)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              const target = removing;
              setRemoving(null);
              if (target) void ws.removeFolder(target.path);
            }}
          >
            Remove
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  if (railOnly) {
    return (
      <aside className="flex h-full w-11 shrink-0 flex-col items-center gap-1 border-r bg-sidebar py-3 text-sidebar-foreground">
        <RailButton label="Show sidebar" shortcut={shortcutLabel("B")} onClick={() => onCollapsedChange(false)}>
          <PanelLeftOpen />
        </RailButton>
        <RailButton label="Filter files" shortcut={shortcutLabel("K")} onClick={onFocusFilter}>
          <Search />
        </RailButton>
        <RailButton label="Rescan" shortcut={shortcutLabel("R")} onClick={() => void ws.rescan()}>
          <RefreshCw className={cn(ws.scanning && "animate-spin")} />
        </RailButton>
        {removeDialog}
      </aside>
    );
  }

  return (
    <aside
      className="relative flex h-full shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground"
      style={{ width }}
    >
      <div className="flex items-center gap-1 px-3 pt-3 pb-2">
        <span className="flex-1 text-sm font-semibold tracking-tight">EnvDeck</span>
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Add folder">
                  <FolderPlus />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>Add folder</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => void ws.addFolder(true)}>Add folder…</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void ws.addFolder(false)}>
              Open folder for this session…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Rescan" onClick={() => void ws.rescan()}>
              <RefreshCw className={cn(ws.scanning && "animate-spin")} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            Rescan <Kbd>{shortcutLabel("R")}</Kbd>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={anyOpen ? "Collapse all" : "Expand all"}
              disabled={allKeys.length === 0}
              onClick={() => setCollapsed(anyOpen ? new Set(allKeys) : new Set())}
            >
              {anyOpen ? <ChevronsDownUp /> : <ChevronsUpDown />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{anyOpen ? "Collapse all" : "Expand all"}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Hide sidebar" onClick={() => onCollapsedChange(true)}>
              <PanelLeftClose />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            Hide sidebar <Kbd>{shortcutLabel("B")}</Kbd>
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="relative px-3 pb-2">
        <Search className="pointer-events-none absolute top-2.5 left-5.5 size-4 text-muted-foreground" />
        <Input
          ref={filterRef}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setFilter("");
              e.currentTarget.blur();
            }
          }}
          placeholder="Filter files"
          aria-label="Filter files"
          className="h-9 bg-background pr-14 pl-8"
        />
        <Kbd className="absolute top-2 right-5">{shortcutLabel("K")}</Kbd>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 px-2 pb-3">
          {ws.manifest?.error && (
            <Alert variant="destructive" className="mx-1">
              <TriangleAlert />
              <AlertTitle>Config file problem</AlertTitle>
              <AlertDescription className="selectable break-words">{ws.manifest.error}</AlertDescription>
            </Alert>
          )}
          {warnings.map((w) => (
            <p key={w} className="mx-1 flex gap-1.5 text-xs text-warning">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              <span className="selectable">{w}</span>
            </p>
          ))}
          {ws.scan?.truncated && (
            <p className="mx-1 text-xs text-warning">
              Stopped after 5,000 files. Point EnvDeck at narrower folders for complete results.
            </p>
          )}

          {folders.map(renderRoot)}
          {tokens.length > 0 && matchCount === 0 && (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">No files match “{filter}”.</p>
          )}

          <div className="pt-1">
            {library ? (
              renderRoot(library)
            ) : (
              <button
                type="button"
                onClick={() => void ws.setLibrary()}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              >
                <Library className="size-4" />
                Choose a library folder…
              </button>
            )}
          </div>
        </div>
      </ScrollArea>

      <div className="flex items-center gap-1 border-t px-3 py-2 text-xs text-muted-foreground">
        <span className="flex-1 truncate">
          {ws.scan ? `${ws.scan.files.length} files · ${ws.scan.elapsedMs} ms` : "Scanning…"}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-xs" aria-label="Settings">
              <Settings2 />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top">
            <DropdownMenuLabel className="selectable font-normal text-muted-foreground">
              {ws.manifest?.configDisplay ?? "~/.envdeck.json"}
            </DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => void ws.reloadManifest()}>Reload config file</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void ws.setLibrary()}>
              {ws.manifest?.library ? "Choose another library…" : "Choose library folder…"}
            </DropdownMenuItem>
            {ws.manifest?.library && (
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => {
                  const lib = ws.manifest?.library;
                  if (lib) setRemoving({ path: lib.path, display: lib.display, library: true });
                }}
              >
                Remove library…
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <ResizeHandle width={width} onWidthChange={onWidthChange} onCollapse={() => onCollapsedChange(true)} />
      {removeDialog}
    </aside>
  );
}

function RailButton({
  label,
  shortcut,
  onClick,
  children,
}: {
  label: string;
  shortcut: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">
        {label} <Kbd>{shortcut}</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}

/** Drag strip on the sidebar's right edge. Arrow keys nudge; double-click resets. */
function ResizeHandle({
  width,
  onWidthChange,
  onCollapse,
}: {
  width: number;
  onWidthChange: (width: number) => void;
  onCollapse: () => void;
}) {
  const [dragging, setDragging] = useState(false);

  // While dragging, keep the resize cursor even when the pointer outruns the strip.
  useEffect(() => {
    if (!dragging) return;
    const body = document.body.style;
    const prev = body.cursor;
    body.cursor = "col-resize";
    return () => {
      body.cursor = prev;
    };
  }, [dragging]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      tabIndex={0}
      className={cn(
        "absolute inset-y-0 -right-0.5 z-10 w-1 cursor-col-resize outline-none hover:bg-border focus-visible:bg-ring",
        dragging && "bg-primary/40 hover:bg-primary/40",
      )}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (!dragging) return;
        // The sidebar starts at the window's left edge, so the pointer's x is the new width.
        const next = resolveDrag(e.clientX, window.innerWidth);
        if (next.collapsed) {
          setDragging(false);
          onCollapse();
        } else {
          onWidthChange(next.width);
        }
      }}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
      onLostPointerCapture={() => setDragging(false)}
      onDoubleClick={() => onWidthChange(clampSidebarWidth(SIDEBAR_DEFAULT, window.innerWidth))}
      onKeyDown={(e) => {
        const step = e.key === "ArrowLeft" ? -16 : e.key === "ArrowRight" ? 16 : 0;
        if (!step) return;
        e.preventDefault();
        onWidthChange(clampSidebarWidth(width + step, window.innerWidth));
      }}
    />
  );
}

type MenuItem = ComponentType<{
  onSelect?: (e: Event) => void;
  variant?: "default" | "destructive";
  children?: ReactNode;
}>;

/** Root folder actions, shared by the ⋯ menu and the right-click menu. */
function RootMenuItems({
  status,
  ws,
  copy,
  onRemove,
  Item,
  Separator,
}: {
  status: RootStatus;
  ws: Workspace;
  copy: CopyActions;
  onRemove: () => void;
  Item: MenuItem;
  Separator: ComponentType;
}) {
  return (
    <>
      {!status.saved && <Item onSelect={() => void ws.saveFolder(status.path)}>Save folder</Item>}
      {status.library && <Item onSelect={() => void ws.setLibrary()}>Choose another library…</Item>}
      <Item onSelect={() => void copy.copyPath(status.path)}>Copy path</Item>
      <Item onSelect={() => void copy.reveal(status.path)}>{copy.revealLabel}</Item>
      <Separator />
      <Item variant="destructive" onSelect={onRemove}>
        {status.library ? "Remove library…" : status.saved ? "Remove saved folder…" : "Close folder"}
      </Item>
    </>
  );
}

function RootSection({
  group,
  ws,
  copy,
  onSelect,
  filtering,
  collapsed,
  onToggle,
  onRemove,
}: {
  group: RootGroup;
  ws: Workspace;
  copy: CopyActions;
  onSelect: (path: string) => void;
  filtering: boolean;
  collapsed: Set<string>;
  onToggle: (key: string) => void;
  onRemove: () => void;
}) {
  const { status, projects } = group;
  if (filtering && projects.length === 0) return null;
  const Icon = status.library ? Library : Folder;
  const key = rootKey(status.path);
  const open = filtering || !collapsed.has(key);
  const menuProps = { status, ws, copy, onRemove };

  return (
    <Collapsible asChild open={open} onOpenChange={() => onToggle(key)}>
      <section>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div className="group/root flex items-center gap-1 rounded-md pr-1 hover:bg-sidebar-accent/60">
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pl-1.5 text-left"
                  title={status.path}
                >
                  <ChevronRight
                    className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
                  />
                  <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
                    {status.library ? `Library · ${status.display}` : status.display}
                  </span>
                  {!open && status.fileCount > 0 && (
                    <span className="text-[10px] text-muted-foreground tabular-nums">{status.fileCount}</span>
                  )}
                  {!status.saved && (
                    <Badge variant="outline" className="h-4 px-1 text-[10px]">
                      session
                    </Badge>
                  )}
                </button>
              </CollapsibleTrigger>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`${status.library ? "Library" : "Folder"} actions for ${status.display}`}
                    className={cn(
                      "group-hover/root:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100",
                      status.library ? "opacity-60" : "opacity-0",
                    )}
                  >
                    <Ellipsis />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <RootMenuItems {...menuProps} Item={DropdownMenuItem} Separator={DropdownMenuSeparator} />
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <RootMenuItems {...menuProps} Item={ContextMenuItem} Separator={ContextMenuSeparator} />
          </ContextMenuContent>
        </ContextMenu>

        <CollapsibleContent>
          {status.status !== "ok" && (
            <p className="mx-2 mb-1 flex items-center gap-1.5 text-xs text-warning">
              <TriangleAlert className="size-3.5 shrink-0" />
              {status.message ?? "Couldn't scan this folder"}
            </p>
          )}
          {status.skipped > 0 && (
            <p className="mx-2 mb-1 text-xs text-muted-foreground">
              {status.skipped} {status.skipped === 1 ? "entry" : "entries"} couldn't be read
            </p>
          )}
          {status.status === "ok" && status.fileCount === 0 && !filtering && (
            <p className="mx-2 mb-1 text-xs text-muted-foreground">No config files found</p>
          )}

          <ul className="space-y-0.5 pl-2">
            {projects.map((p) => {
              const pKey = projectKey(p.key);
              const pOpen = filtering || !collapsed.has(pKey);
              return (
                <li key={p.key}>
                  <Collapsible open={pOpen} onOpenChange={() => onToggle(pKey)}>
                    <CollapsibleTrigger asChild>
                      <button
                        type="button"
                        className="flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-left text-sm hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                        title={p.key}
                      >
                        <ChevronRight
                          className={cn(
                            "size-3.5 shrink-0 text-muted-foreground transition-transform",
                            pOpen && "rotate-90",
                          )}
                        />
                        <span className="truncate font-medium">{p.name}</span>
                        {p.relPath && p.relPath !== p.name && (
                          <span className="truncate text-xs text-muted-foreground">{p.relPath}</span>
                        )}
                      </button>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <ul>
                        {p.files.map((f) => (
                          <li key={f.path}>
                            <FileRow
                              file={f}
                              selected={ws.selectedPath === f.path}
                              onSelect={() => onSelect(f.path)}
                              copy={copy}
                            />
                          </li>
                        ))}
                      </ul>
                    </CollapsibleContent>
                  </Collapsible>
                </li>
              );
            })}
          </ul>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

function FileRow({
  file,
  selected,
  onSelect,
  copy,
}: {
  file: ConfigFile;
  selected: boolean;
  onSelect: () => void;
  copy: CopyActions;
}) {
  const slash = file.relPath.lastIndexOf("/");
  const dir = slash >= 0 ? file.relPath.slice(0, slash + 1) : "";
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          onClick={onSelect}
          aria-current={selected ? "true" : undefined}
          title={file.path}
          className={cn(
            "flex w-full items-center gap-2 rounded-md py-1 pr-2 pl-6 text-left text-sm",
            selected
              ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
              : "hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
          )}
        >
          <FileIcon kind={file.kind} />
          <span className="truncate">
            {dir && <span className="text-muted-foreground">{dir}</span>}
            {file.name}
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => void copy.openInEditor(file.path)}>Open in {copy.editorName}</ContextMenuItem>
        <ContextMenuItem onSelect={() => void copy.copyFile(file.path)}>
          Copy file
          <ContextMenuShortcut>{shortcutLabel("F", { shift: true })}</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void copy.copyPath(file.path)}>Copy path</ContextMenuItem>
        <ContextMenuItem onSelect={() => void copy.copyText(file.relPath, "relative path")}>
          Copy relative path
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => void copy.reveal(file.path)}>{copy.revealLabel}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
