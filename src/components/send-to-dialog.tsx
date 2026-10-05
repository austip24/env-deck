import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { FileIcon } from "@/components/file-icon";
import { Badge } from "@/components/ui/badge";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { effectiveVars, isBackupName, isSecret, MASK, planSend, type SendPlan, type Var } from "@/lib/env";
import { errorText, ipc, type ConfigFile, type ScanResult } from "@/lib/ipc";
import { displayPath } from "@/lib/platform";
import { cn } from "@/lib/utils";

/** Upserts variables into another dotenv file, after showing which keys are added or replaced. */
export function SendToDialog({
  open,
  onOpenChange,
  sourcePath,
  vars,
  scan,
  home,
  revealAll,
  onSent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourcePath: string;
  vars: Var[];
  scan: ScanResult | null;
  home: string | null;
  revealAll: boolean;
  onSent: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [target, setTarget] = useState<ConfigFile | null>(null);
  const [plan, setPlan] = useState<SendPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const targets = useMemo(
    () =>
      (scan?.files ?? []).filter(
        (f) =>
          // Not templates (usually committed to git) and not EnvDeck's own backups.
          f.kind === "env" &&
          !isBackupName(f.name) &&
          f.path !== sourcePath &&
          `${f.projectName}/${f.relPath}`.toLowerCase().includes(filter.toLowerCase()),
      ),
    [scan, sourcePath, filter],
  );

  useEffect(() => {
    if (!target) return;
    let live = true;
    setPlan(null);
    setPlanError(null);
    ipc
      .readConfig(target.path)
      .then((c) => live && setPlan(planSend(vars, c.env ? effectiveVars(c.env) : [])))
      .catch((e) => live && setPlanError(errorText(e)));
    return () => {
      live = false;
    };
  }, [target, vars]);

  const changes = plan ? [...plan.add, ...plan.replace] : [];

  const send = async () => {
    if (!target || !plan || changes.length === 0) return;
    setBusy(true);
    try {
      await ipc.setEnvVars(
        target.path,
        changes.map(({ key, value }) => ({ key, value })),
      );
      const parts = [
        plan.add.length && `added ${plan.add.length}`,
        plan.replace.length && `updated ${plan.replace.length}`,
      ].filter(Boolean);
      toast.success(`${target.name} in ${target.projectName}: ${parts.join(", ")}`);
      onOpenChange(false);
      onSent();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const show = (key: string, value: string) => (revealAll || !isSecret(key, value) ? value || "(empty)" : MASK);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Send {vars.length} {vars.length === 1 ? "variable" : "variables"} to…
          </DialogTitle>
          <DialogDescription>
            Updates the other file in place, keeping its comments, order and line endings.
          </DialogDescription>
        </DialogHeader>

        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter dotenv files"
          aria-label="Filter dotenv files"
          className="h-8"
        />
        <ScrollArea className="h-40 rounded-md border">
          <ul className="p-1" role="listbox" aria-label="Target file">
            {targets.map((f) => (
              <li key={f.path}>
                <button
                  type="button"
                  role="option"
                  aria-selected={target?.path === f.path}
                  onClick={() => setTarget(f)}
                  title={f.path}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm",
                    target?.path === f.path ? "bg-primary text-primary-foreground" : "hover:bg-accent",
                  )}
                >
                  <FileIcon kind={f.kind} className={cn(target?.path === f.path && "text-current")} />
                  <span className="truncate">
                    <span className="font-medium">{f.projectName}</span>
                    <span className="opacity-70"> / {f.relPath}</span>
                  </span>
                </button>
              </li>
            ))}
            {targets.length === 0 && (
              <li className="px-2 py-6 text-center text-sm text-muted-foreground">No other dotenv files</li>
            )}
          </ul>
        </ScrollArea>

        {target && (
          <div className="space-y-1.5">
            <p className="selectable truncate text-xs text-muted-foreground">{displayPath(target.path, home)}</p>
            {planError && <p className="text-xs text-destructive">{planError}</p>}
            {plan && (
              <div className="max-h-40 overflow-auto rounded-md border">
                <ul className="divide-y text-sm">
                  {plan.add.map((v) => (
                    <li key={v.key} className="flex items-center gap-2 px-2 py-1">
                      <Badge className="bg-success text-success-foreground">add</Badge>
                      <span className="font-mono text-xs">{v.key}</span>
                      <span className="ml-auto truncate font-mono text-xs text-muted-foreground">{show(v.key, v.value)}</span>
                    </li>
                  ))}
                  {plan.replace.map((v) => (
                    <li key={v.key} className="flex items-center gap-2 px-2 py-1">
                      <Badge className="bg-warning text-warning-foreground">replace</Badge>
                      <span className="font-mono text-xs">{v.key}</span>
                      <span className="ml-auto truncate font-mono text-xs text-muted-foreground">
                        {show(v.key, v.previous)} → {show(v.key, v.value)}
                      </span>
                    </li>
                  ))}
                  {plan.same.map((v) => (
                    <li key={v.key} className="flex items-center gap-2 px-2 py-1 text-muted-foreground">
                      <Badge variant="outline">same</Badge>
                      <span className="font-mono text-xs">{v.key}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void send()} disabled={!plan || changes.length === 0 || busy}>
            {plan && changes.length === 0 ? "Nothing to change" : `Send${changes.length ? ` ${changes.length}` : ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
