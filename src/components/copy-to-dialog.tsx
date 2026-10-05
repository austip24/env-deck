import { useMemo, useState } from "react";
import { FolderOpen, Library, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { isDotenvName } from "@/lib/env";
import { errorCode, errorText, ipc, type ConfigContent, type OnConflict, type ScanResult } from "@/lib/ipc";
import { dirOf, displayPath, joinPath } from "@/lib/platform";
import { cn } from "@/lib/utils";

interface Destination {
  path: string;
  label: string;
  library?: boolean;
}

const POLICIES: { id: OnConflict; label: string; hint: string }[] = [
  { id: "fail", label: "Don't overwrite", hint: "Stop if the file already exists." },
  { id: "backup", label: "Back up, then replace", hint: "Keeps the old file as <name>.bak-<time>." },
  { id: "keepBoth", label: "Keep both", hint: "Saves the copy as <name>.copy." },
  { id: "merge", label: "Merge variables", hint: "Adds and updates keys, keeping comments and order." },
  { id: "overwrite", label: "Replace", hint: "Overwrites the existing file." },
];

/** Projects from the scan, plus the library root, deduplicated and sorted by name. */
function destinationsFrom(scan: ScanResult | null, home: string | null): Destination[] {
  if (!scan) return [];
  const out = new Map<string, Destination>();
  for (const f of scan.files) {
    if (!out.has(f.project)) {
      out.set(f.project, { path: f.project, label: displayPath(f.project, home) });
    }
  }
  for (const r of scan.roots) {
    if (r.library && r.status === "ok") out.set(r.path, { path: r.path, label: r.display, library: true });
  }
  return [...out.values()].sort((a, b) => Number(!!b.library) - Number(!!a.library) || a.label.localeCompare(b.label));
}

export function CopyToDialog({
  open,
  onOpenChange,
  source,
  scan,
  home,
  onCopied,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: ConfigContent;
  scan: ScanResult | null;
  home: string | null;
  onCopied: (path: string) => void;
}) {
  const [picked, setPicked] = useState<Destination[]>([]);
  const destinations = useMemo(() => [...picked, ...destinationsFrom(scan, home)], [picked, scan, home]);
  const sourceDir = dirOf(source.path);
  const [dest, setDest] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [fileName, setFileName] = useState(source.name);
  const [policy, setPolicy] = useState<OnConflict>("fail");
  const [busy, setBusy] = useState(false);
  const [exists, setExists] = useState(false);

  const visible = destinations.filter((d) => d.label.toLowerCase().includes(filter.toLowerCase()));
  const nameError = /[\\/:*?"<>|]/.test(fileName) || fileName.trim() === "" || fileName === "." || fileName === "..";
  const target = dest ? joinPath(dest, fileName) : null;
  const knownToExist = !!target && (exists || !!scan?.files.some((f) => f.path === target));
  const mergeAllowed = isDotenvName(source.name) && isDotenvName(fileName);
  const sameFile = target === source.path;

  const browse = async () => {
    try {
      const path = await ipc.pickDestination();
      if (!path) return;
      setPicked((p) => (p.some((d) => d.path === path) ? p : [{ path, label: displayPath(path, home) }, ...p]));
      setDest(path);
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  const submit = async () => {
    if (!dest || nameError || sameFile) return;
    setBusy(true);
    try {
      const out = await ipc.copyConfig(source.path, dest, policy, fileName);
      const where = displayPath(out.path, home);
      const messages: Record<typeof out.action, string> = {
        created: `Copied to ${where}`,
        backedUp: `Replaced ${where}`,
        keptBoth: `Saved as ${where}`,
        merged: `Merged into ${where}`,
        overwritten: `Replaced ${where}`,
      };
      toast.success(messages[out.action], {
        description: out.backupPath ? `Old file kept as ${displayPath(out.backupPath, home)}` : undefined,
      });
      onOpenChange(false);
      onCopied(out.path);
    } catch (e) {
      if (errorCode(e) === "EXISTS") setExists(true);
      else toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Copy {source.name} to…</DialogTitle>
          <DialogDescription className="selectable truncate">{displayPath(source.path, home)}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <div className="flex gap-2">
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter projects"
              aria-label="Filter destinations"
              className="h-8"
            />
            <Button variant="outline" size="sm" onClick={() => void browse()}>
              <FolderOpen /> Browse…
            </Button>
          </div>
          <ScrollArea className="h-48 rounded-md border">
            <ul className="p-1" role="listbox" aria-label="Destination folder">
              {visible.map((d) => (
                <li key={d.path}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={dest === d.path}
                    onClick={() => {
                      setDest(d.path);
                      setExists(false);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm",
                      dest === d.path ? "bg-primary text-primary-foreground" : "hover:bg-accent",
                    )}
                    title={d.path}
                  >
                    {d.library && <Library className="size-3.5 shrink-0" />}
                    <span className="truncate">{d.label}</span>
                    {d.path === sourceDir && <span className="ml-auto shrink-0 text-xs opacity-70">this folder</span>}
                  </button>
                </li>
              ))}
              {visible.length === 0 && (
                <li className="px-2 py-6 text-center text-sm text-muted-foreground">No matching folders</li>
              )}
            </ul>
          </ScrollArea>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="copy-file-name">File name</Label>
          <Input
            id="copy-file-name"
            value={fileName}
            onChange={(e) => {
              setFileName(e.target.value);
              setExists(false);
            }}
            aria-invalid={nameError || sameFile}
            className="font-mono"
          />
          {nameError && <p className="text-xs text-destructive">Use a plain file name without / \ : * ? " &lt; &gt; |</p>}
          {sameFile && <p className="text-xs text-destructive">That's the file itself. Pick another folder or name.</p>}
        </div>

        <div className="space-y-1.5">
          <Label>If {fileName || "the file"} already exists</Label>
          <RadioGroup value={policy} onValueChange={(v) => setPolicy(v as OnConflict)} className="gap-1.5">
            {POLICIES.map((p) => {
              const disabled = p.id === "merge" && !mergeAllowed;
              return (
                <label
                  key={p.id}
                  className={cn("flex items-start gap-2 text-sm", disabled && "cursor-not-allowed opacity-50")}
                >
                  <RadioGroupItem value={p.id} disabled={disabled} className="mt-0.5" />
                  <span>
                    {p.label}
                    <span className="ml-1.5 text-xs text-muted-foreground">
                      {disabled ? "Only between dotenv files." : p.hint}
                    </span>
                  </span>
                </label>
              );
            })}
          </RadioGroup>
          {knownToExist && policy === "fail" && (
            <p className="flex items-center gap-1.5 text-xs text-warning">
              <TriangleAlert className="size-3.5" />
              {fileName} already exists there. Choose what to do with it.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!dest || nameError || sameFile || busy}>
            Copy
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
