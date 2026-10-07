import { useEffect, useRef, useState } from "react";
import { NoFolders, NoSelection } from "@/components/empty-state";
import { FileError, FileView } from "@/components/file-view";
import { Sidebar } from "@/components/sidebar";
import { TutorialDialog } from "@/components/tutorial-dialog";
import { UpdateDialog } from "@/components/update-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useCopy } from "@/hooks/use-copy";
import { useUpdate } from "@/hooks/use-update";
import { useWorkspace } from "@/hooks/use-workspace";
import { isModKey } from "@/lib/platform";
import { clampSidebarWidth, SIDEBAR_DEFAULT } from "@/lib/sidebar";
import { shouldAutoShowTutorial } from "@/lib/tutorial";

function App() {
  const ws = useWorkspace();
  const copy = useCopy(ws.manifest?.settings.editor);
  const updates = useUpdate();
  const { rescan } = ws;
  // Sidebar layout is in memory only; it resets on every launch.
  const [sidebarWidth, setSidebarWidth] = useState(() => clampSidebarWidth(SIDEBAR_DEFAULT, window.innerWidth));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [filterRequest, setFilterRequest] = useState(0);
  const focusFilter = () => {
    setSidebarCollapsed(false);
    setFilterRequest((n) => n + 1);
  };
  // Unsaved edits in the source editor; switching files asks first.
  const [dirty, setDirty] = useState(false);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const { setHoldSelection } = ws;
  useEffect(() => setHoldSelection(dirty), [dirty, setHoldSelection]);

  // The tour opens by itself only if the first manifest is empty (a fresh start). Dismissing it
  // isn't stored anywhere; the gear menu reopens it.
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const tutorialChecked = useRef(false);
  useEffect(() => {
    if (!ws.manifest || tutorialChecked.current) return;
    tutorialChecked.current = true;
    if (shouldAutoShowTutorial(ws.manifest)) setTutorialOpen(true);
  }, [ws.manifest]);
  const showTutorial = () => setTutorialOpen(true);

  const open = (path: string) => {
    if (path === ws.selectedPath) return;
    if (dirty) setPendingPath(path);
    else ws.select(path);
  };

  useEffect(() => {
    const onResize = () => setSidebarWidth((w) => clampSidebarWidth(w, window.innerWidth));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // ⌘/Ctrl+K filter, ⌘/Ctrl+R rescan, ⌘/Ctrl+B toggle sidebar. C, V, X, A and Z are left to
  // the webview.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isModKey(e) || e.altKey || e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (key === "k") {
        e.preventDefault();
        setSidebarCollapsed(false);
        setFilterRequest((n) => n + 1);
      } else if (key === "b") {
        e.preventDefault();
        setSidebarCollapsed((c) => !c);
      } else if (key === "r") {
        // Also stops the webview's own reload.
        e.preventDefault();
        void rescan();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rescan]);

  const hasFolders = (ws.manifest?.roots.length ?? 0) > 0;

  let main;
  if (ws.manifest && !hasFolders && !ws.manifest.library) {
    main = <NoFolders onAdd={(persist) => void ws.addFolder(persist)} onShowTutorial={showTutorial} />;
  } else if (ws.contentError && ws.selectedPath) {
    main = <FileError message={ws.contentError} onRetry={() => void ws.reloadSelected()} />;
  } else if (ws.content) {
    const path = ws.content.path;
    main = (
      <FileView
        key={path}
        content={ws.content}
        file={ws.scan?.files.find((f) => f.path === path)}
        scan={ws.scan}
        home={ws.manifest?.home ?? null}
        copy={copy}
        onDirtyChange={setDirty}
        afterWrite={ws.afterWrite}
      />
    );
  } else if (!ws.selectedPath) {
    main = <NoSelection fileCount={ws.scan?.files.length ?? 0} />;
  }

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-full overflow-hidden">
        <Sidebar
          ws={ws}
          copy={copy}
          onSelect={open}
          width={sidebarWidth}
          onWidthChange={setSidebarWidth}
          collapsed={sidebarCollapsed}
          onCollapsedChange={setSidebarCollapsed}
          filterRequest={filterRequest}
          onFocusFilter={focusFilter}
          onShowTutorial={showTutorial}
          updates={updates}
        />
        <main className="min-w-0 flex-1">{main}</main>
      </div>

      <Dialog open={pendingPath !== null} onOpenChange={(o) => !o && setPendingPath(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogDescription>Your edits to {ws.content?.name ?? "this file"} haven't been saved.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingPath(null)}>
              Keep editing
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const path = pendingPath;
                setPendingPath(null);
                setDirty(false);
                if (path) ws.select(path);
              }}
            >
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <TutorialDialog open={tutorialOpen} onOpenChange={setTutorialOpen} ws={ws} />
      <UpdateDialog updates={updates} />

      <Toaster position="bottom-right" />
    </TooltipProvider>
  );
}

export default App;
