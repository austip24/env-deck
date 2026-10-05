import { useEffect, useRef, useState } from "react";
import { Save, TriangleAlert, X } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { withLineEnding } from "@/lib/env";
import { errorCode, errorText, ipc, type ConfigContent } from "@/lib/ipc";
import { isModKey, shortcutLabel } from "@/lib/platform";

/** The editor works in `\n`; saving converts back to the file's own ending. */
const toEditor = (text: string) => text.replace(/\r\n/g, "\n");

/**
 * Edits a file's raw text. Values are shown unmasked (with a warning) while editing. Saves pass
 * the mtime the file was loaded with, so a file changed on disk since is never overwritten.
 */
export function SourceEditor({
  content,
  onSaved,
  onCancel,
  onDirtyChange,
  onReload,
}: {
  content: ConfigContent;
  onSaved: () => void;
  onCancel: () => void;
  onDirtyChange: (dirty: boolean) => void;
  /** Discard the draft and load the file from disk again. */
  onReload: () => void;
}) {
  // The version the draft is based on. Saves send its mtime, so a newer file on disk is never
  // overwritten, even after the watcher has reloaded `content` underneath the editor.
  const [base, setBase] = useState(() => ({ text: toEditor(content.text), modifiedMs: content.modifiedMs }));
  const [draft, setDraft] = useState(base.text);
  const [saving, setSaving] = useState(false);
  const [stale, setStale] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const dirty = draft !== base.text;

  // The file changed on disk while editing: follow it if there are no edits, else warn now
  // rather than at save time.
  useEffect(() => {
    if (content.modifiedMs === base.modifiedMs) return;
    if (draft === base.text) {
      const next = { text: toEditor(content.text), modifiedMs: content.modifiedMs };
      setBase(next);
      setDraft(next.text);
    } else {
      setStale(true);
    }
    // Only react to new versions of the file, not to typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content.modifiedMs, content.text]);

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => ref.current?.focus(), []);

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      await ipc.writeConfig(content.path, withLineEnding(draft, content.lineEnding), base.modifiedMs);
      toast.success(`Saved ${content.name}`);
      onDirtyChange(false);
      onSaved();
    } catch (e) {
      if (errorCode(e) === "STALE") setStale(true);
      else toast.error(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  // ⌘/Ctrl+S saves.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isModKey(e) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex items-center gap-1.5 text-xs text-warning">
          <TriangleAlert className="size-3.5 shrink-0" />
          Values are shown unmasked while editing.
        </p>
        <span className="text-xs text-muted-foreground">
          Saves with {content.lineEnding.toUpperCase()} line endings{content.hasBom ? " and a UTF-8 BOM" : ""}.
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            <X /> {dirty ? "Discard" : "Done"}
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={!dirty || saving || stale}>
            <Save /> Save <Kbd className="bg-primary-foreground/20 text-primary-foreground">{shortcutLabel("S")}</Kbd>
          </Button>
        </div>
      </div>
      {stale ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>{content.name} changed on disk</AlertTitle>
          <AlertDescription>
            <p>Another program saved this file while you were editing. EnvDeck won't overwrite it.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void ipc.writeClipboardText(draft).then(() => toast.success("Copied your edits"))}
              >
                Copy my edits
              </Button>
              <Button variant="outline" size="sm" onClick={onReload}>
                Discard and reload
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      <textarea
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-label={`Edit ${content.name}`}
        className="selectable min-h-0 flex-1 resize-none rounded-md border bg-background p-3 font-mono text-[13px] leading-6 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
      />

    </div>
  );
}
