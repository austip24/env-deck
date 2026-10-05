// Workspace state: manifest, scan results and the selected file. Everything lives in React
// state and is gone on quit; the file system (via lib/ipc.ts) is the source of truth.

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { errorText, ipc, onConfigsChanged, type ConfigContent, type ManifestView, type ScanResult } from "@/lib/ipc";

export interface Workspace {
  manifest: ManifestView | null;
  scan: ScanResult | null;
  scanning: boolean;
  selectedPath: string | null;
  content: ConfigContent | null;
  contentError: string | null;
  loadingContent: boolean;
  select: (path: string | null) => void;
  rescan: () => Promise<void>;
  reloadSelected: () => Promise<void>;
  /** After EnvDeck writes a file: rescan, then open `open` or reload the current file. */
  afterWrite: (open?: string) => Promise<void>;
  /**
   * While true (unsaved edits), the open file stays open even if it disappears or can't be
   * re-read, so the draft isn't lost.
   */
  setHoldSelection: (hold: boolean) => void;
  addFolder: (persist: boolean) => Promise<void>;
  saveFolder: (path: string) => Promise<void>;
  removeFolder: (path: string) => Promise<void>;
  setLibrary: () => Promise<void>;
  reloadManifest: () => Promise<void>;
}

export function useWorkspace(): Workspace {
  const [manifest, setManifest] = useState<ManifestView | null>(null);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState<ConfigContent | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);

  // Sequence numbers drop responses that arrive after a newer request.
  const scanSeq = useRef(0);
  const readSeq = useRef(0);
  const selectedRef = useRef<string | null>(null);
  const holdRef = useRef(false);

  const load = useCallback(async (path: string | null) => {
    const seq = ++readSeq.current;
    if (!path) {
      setContent(null);
      setContentError(null);
      return;
    }
    setLoadingContent(true);
    try {
      const c = await ipc.readConfig(path);
      if (seq !== readSeq.current) return;
      setContent(c);
      setContentError(null);
    } catch (e) {
      if (seq !== readSeq.current) return;
      if (holdRef.current) {
        toast.error(errorText(e));
        return;
      }
      setContent(null);
      setContentError(errorText(e));
    } finally {
      if (seq === readSeq.current) setLoadingContent(false);
    }
  }, []);

  const select = useCallback(
    (path: string | null) => {
      selectedRef.current = path;
      setSelectedPath(path);
      void load(path);
    },
    [load],
  );

  const reloadSelected = useCallback(() => load(selectedRef.current), [load]);

  const rescan = useCallback(async () => {
    const seq = ++scanSeq.current;
    setScanning(true);
    try {
      const result = await ipc.scan();
      if (seq !== scanSeq.current) return;
      setScan(result);
      // Drop the selection if the file is gone.
      const sel = selectedRef.current;
      if (sel && !holdRef.current && !result.files.some((f) => f.path === sel)) select(null);
    } catch (e) {
      if (seq === scanSeq.current) toast.error(errorText(e));
    } finally {
      if (seq === scanSeq.current) setScanning(false);
    }
  }, [select]);

  const afterWrite = useCallback(
    async (open?: string) => {
      await rescan();
      if (open) select(open);
      else await reloadSelected();
    },
    [rescan, select, reloadSelected],
  );

  /** Runs a folder/manifest action, then refreshes the manifest and rescans. */
  const withRefresh = useCallback(
    async (action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (e) {
        toast.error(errorText(e));
      }
      try {
        setManifest(await ipc.getManifest());
      } catch (e) {
        toast.error(errorText(e));
      }
      await rescan();
    },
    [rescan],
  );

  useEffect(() => {
    void withRefresh(async () => {});
  }, [withRefresh]);

  // Watcher pushes (watch.rs): rescan, and reload the open file if it changed. Batches arriving
  // close together (including the echo of EnvDeck's own writes) collapse into one refresh.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: string[] | null = null; // null = nothing queued; [] = everything
    const flush = () => {
      const paths = pending ?? [];
      pending = null;
      const sel = selectedRef.current;
      void rescan();
      if (sel && (paths.length === 0 || paths.includes(sel))) void reloadSelected();
    };
    const unlisten = onConfigsChanged((paths) => {
      pending = paths.length === 0 || pending?.length === 0 ? [] : [...(pending ?? []), ...paths];
      clearTimeout(timer);
      timer = setTimeout(flush, 250);
    });
    return () => {
      clearTimeout(timer);
      void unlisten.then((f) => f());
    };
  }, [rescan, reloadSelected]);

  return {
    manifest,
    scan,
    scanning,
    selectedPath,
    content,
    contentError,
    loadingContent,
    select,
    rescan,
    reloadSelected,
    afterWrite,
    setHoldSelection: useCallback((hold: boolean) => {
      holdRef.current = hold;
    }, []),
    addFolder: (persist) => withRefresh(() => ipc.addFolder(persist)),
    saveFolder: (path) => withRefresh(() => ipc.saveFolder(path)),
    removeFolder: (path) => withRefresh(() => ipc.removeFolder(path)),
    setLibrary: () => withRefresh(() => ipc.setLibrary()),
    reloadManifest: () => withRefresh(() => ipc.reloadManifest()),
  };
}
