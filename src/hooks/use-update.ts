// In-app updates from GitHub Releases (update.rs). One quiet check at launch, plus "Check for
// updates…" in the Settings menu. Nothing is stored: "Later" lasts until quit.

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { errorText, ipc, onUpdateProgress, type UpdateInfo, type UpdateProgress } from "@/lib/ipc";

export interface Updates {
  /** The newer release the last check found, or null. */
  update: UpdateInfo | null;
  dialogOpen: boolean;
  setDialogOpen: (open: boolean) => void;
  checking: boolean;
  installing: boolean;
  progress: UpdateProgress | null;
  /** Manual check: always reports the outcome. */
  check: () => Promise<void>;
  install: () => Promise<void>;
}

export function useUpdate(): Updates {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const launched = useRef(false);

  // Launch check: offline or a failed check stays silent.
  useEffect(() => {
    if (launched.current) return;
    launched.current = true;
    ipc
      .checkUpdate()
      .then((found) => {
        setUpdate(found);
        if (found) {
          toast(`EnvDeck ${found.version} is available`, {
            action: { label: "View", onClick: () => setDialogOpen(true) },
          });
        }
      })
      .catch(() => {});
  }, []);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const found = await ipc.checkUpdate();
      setUpdate(found);
      if (found) setDialogOpen(true);
      else toast.success("EnvDeck is up to date");
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setChecking(false);
    }
  }, []);

  const install = useCallback(async () => {
    setInstalling(true);
    setProgress(null);
    const unlisten = await onUpdateProgress(setProgress);
    try {
      // Restarts the app on success, so this normally doesn't return.
      await ipc.installUpdate();
    } catch (e) {
      toast.error(errorText(e));
      setInstalling(false);
    } finally {
      unlisten();
    }
  }, []);

  return { update, dialogOpen, setDialogOpen, checking, installing, progress, check, install };
}
