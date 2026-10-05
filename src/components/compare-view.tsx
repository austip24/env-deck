import { useEffect, useMemo, useState } from "react";
import { Eye, EyeOff, Plus } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { compareEnv, effectiveVars, isBackupName, isSecret, MASK, type CompareRow, type Var } from "@/lib/env";
import { errorText, ipc, type ConfigContent, type ConfigFile, type ScanResult } from "@/lib/ipc";
import { dirOf } from "@/lib/platform";
import { cn } from "@/lib/utils";

const STATUS: Record<CompareRow["status"], { label: string; className: string }> = {
  onlyA: { label: "only here", className: "bg-primary/10 text-primary" },
  onlyB: { label: "missing here", className: "bg-warning/15 text-warning" },
  differs: { label: "differs", className: "bg-secondary text-secondary-foreground" },
  same: { label: "same", className: "text-muted-foreground" },
};

/** Default comparison: the sibling template (or the sibling .env for a template), else the same project. */
export function defaultCompareTarget(content: ConfigContent, candidates: ConfigFile[]): ConfigFile | undefined {
  const dir = dirOf(content.path);
  const siblings = candidates.filter((f) => dirOf(f.path) === dir);
  const wantKind = content.kind === "env-template" ? "env" : "env-template";
  const self = candidates.find((f) => f.path === content.path);
  return (
    siblings.find((f) => f.kind === wantKind) ??
    siblings[0] ??
    candidates.find((f) => self && f.project === self.project) ??
    candidates[0]
  );
}

export function CompareView({
  content,
  scan,
  revealAll,
  onWrote,
}: {
  content: ConfigContent;
  scan: ScanResult | null;
  revealAll: boolean;
  onWrote: () => void;
}) {
  const candidates = useMemo(
    () =>
      (scan?.files ?? []).filter(
        (f) => (f.kind === "env" || f.kind === "env-template") && !isBackupName(f.name) && f.path !== content.path,
      ),
    [scan, content.path],
  );
  const [otherPath, setOtherPath] = useState<string | undefined>(() => defaultCompareTarget(content, candidates)?.path);
  const [other, setOther] = useState<ConfigContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [differencesOnly, setDifferencesOnly] = useState(false);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!otherPath) return;
    let live = true;
    setError(null);
    ipc
      .readConfig(otherPath)
      .then((c) => live && setOther(c))
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
    // `scan` changes on every rescan, so edits to the other file show up too.
  }, [otherPath, content, scan]);

  const here: Var[] = useMemo(() => (content.env ? effectiveVars(content.env) : []), [content]);
  const there: Var[] = useMemo(() => (other?.env ? effectiveVars(other.env) : []), [other]);
  const rows = useMemo(() => compareEnv(here, there), [here, there]);
  const missing = rows.filter((r) => r.status === "onlyB");
  const shown = differencesOnly ? rows.filter((r) => r.status !== "same") : rows;
  const otherFile = candidates.find((f) => f.path === otherPath);

  const addMissing = async () => {
    if (missing.length === 0) return;
    setBusy(true);
    try {
      await ipc.setEnvVars(
        content.path,
        missing.map((r) => ({ key: r.key, value: r.b ?? "" })),
      );
      toast.success(`Added ${missing.length} missing ${missing.length === 1 ? "key" : "keys"} to ${content.name}`);
      onWrote();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const cell = (key: string, value: string | null) => {
    if (value === null) return <span className="text-muted-foreground">—</span>;
    if (value === "") return <span className="text-muted-foreground italic">empty</span>;
    if (isSecret(key, value) && !revealAll && !revealed.has(key)) {
      return <span className="tracking-widest text-muted-foreground">{MASK}</span>;
    }
    return <span className="selectable line-clamp-3 break-all whitespace-pre-wrap">{value}</span>;
  };

  if (candidates.length === 0) {
    return <p className="p-6 text-sm text-muted-foreground">There's no other dotenv file in the scanned folders to compare with.</p>;
  }

  return (
    <div className="flex flex-col gap-3 px-3 pt-3 pb-6">
      <div className="flex flex-wrap items-center gap-2 px-2">
        <span className="text-sm text-muted-foreground">Compare with</span>
        <Select value={otherPath} onValueChange={(v) => setOtherPath(v)}>
          <SelectTrigger size="sm" className="max-w-[22rem] min-w-48">
            <SelectValue placeholder="Choose a file" />
          </SelectTrigger>
          <SelectContent>
            {candidates.map((f) => (
              <SelectItem key={f.path} value={f.path}>
                {f.projectName} / {f.relPath}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
          <Switch checked={differencesOnly} onCheckedChange={setDifferencesOnly} />
          Differences only
        </label>
        <Button size="sm" onClick={() => void addMissing()} disabled={missing.length === 0 || busy}>
          <Plus /> Add {missing.length || ""} missing {missing.length === 1 ? "key" : "keys"}
        </Button>
      </div>
      {otherFile?.kind === "env-template" && missing.length > 0 && (
        <p className="px-2 text-xs text-muted-foreground">Missing keys are added with the template's values (often empty).</p>
      )}
      {error && <p className="px-2 text-sm text-destructive">{error}</p>}

      <Table className="table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead className="w-[30%]">Key</TableHead>
            <TableHead>{content.name} (this file)</TableHead>
            <TableHead>{otherFile ? `${otherFile.projectName} / ${otherFile.relPath}` : "Other"}</TableHead>
            <TableHead className="w-28 text-right">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((r) => {
            const secret = isSecret(r.key, r.a ?? "") || isSecret(r.key, r.b ?? "");
            return (
              <TableRow key={r.key} className={cn(r.status === "same" && "text-muted-foreground")}>
                <TableCell className="align-top">
                  <div className="flex items-center gap-1">
                    <span className="selectable truncate font-mono text-[13px]" title={r.key}>
                      {r.key}
                    </span>
                    {secret && !revealAll && (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="text-muted-foreground"
                        aria-label={revealed.has(r.key) ? `Hide ${r.key}` : `Reveal ${r.key}`}
                        onClick={() =>
                          setRevealed((s) => {
                            const next = new Set(s);
                            if (next.has(r.key)) next.delete(r.key);
                            else next.add(r.key);
                            return next;
                          })
                        }
                      >
                        {revealed.has(r.key) ? <EyeOff /> : <Eye />}
                      </Button>
                    )}
                  </div>
                </TableCell>
                <TableCell className="align-top font-mono text-[13px] whitespace-normal">{cell(r.key, r.a)}</TableCell>
                <TableCell className="align-top font-mono text-[13px] whitespace-normal">{cell(r.key, r.b)}</TableCell>
                <TableCell className="text-right align-top">
                  <Badge variant="outline" className={cn("border-transparent font-normal", STATUS[r.status].className)}>
                    {STATUS[r.status].label}
                  </Badge>
                </TableCell>
              </TableRow>
            );
          })}
          {shown.length === 0 && (
            <TableRow>
              <TableCell colSpan={4} className="py-6 text-center text-sm text-muted-foreground">
                {rows.length ? "No differences." : "Neither file defines variables."}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
