import { useEffect, useMemo, useRef, useState } from "react";
import { Eye, EyeOff, FilePlus2, RefreshCw, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { AzurePushDialog } from "@/components/azure-push-dialog";
import { CompareView } from "@/components/compare-view";
import { CopyToDialog } from "@/components/copy-to-dialog";
import { EnvTable, type Reveal } from "@/components/env-table";
import { FileActions } from "@/components/file-actions";
import { FileIcon, KIND_LABELS } from "@/components/file-icon";
import { GithubPushDialog } from "@/components/github-push-dialog";
import { SendToDialog } from "@/components/send-to-dialog";
import { SourceEditor } from "@/components/source-editor";
import { SourceView, structuredSecretLines } from "@/components/source-view";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { CopyActions } from "@/hooks/use-copy";
import { crossPromptFor, SERVICE_LABELS, type CrossPrompt, type PushService } from "@/lib/cross-push";
import { effectiveVars, isSecret, pairsOf, templateTarget } from "@/lib/env";
import {
  errorCode,
  errorText,
  ipc,
  type ConfigContent,
  type AzureHint,
  type ConfigFile,
  type GithubRepoInfo,
  type ScanResult,
} from "@/lib/ipc";
import { dirOf, displayPath, formatBytes, joinPath, relativeTime } from "@/lib/platform";

type Tab = "variables" | "source" | "compare";

/** Shows one file. Mount with `key={content.path}` so reveal and selection reset per file. */
export function FileView({
  content,
  file,
  scan,
  home,
  copy,
  onDirtyChange,
  afterWrite,
}: {
  content: ConfigContent;
  /** The scan entry for this file (project-relative path), when known. */
  file: ConfigFile | undefined;
  scan: ScanResult | null;
  home: string | null;
  copy: CopyActions;
  /** Reports unsaved edits so the app can confirm before leaving the file. */
  onDirtyChange: (dirty: boolean) => void;
  /** Rescan and reload after a write; `open` switches to another file. */
  afterWrite: (open?: string) => Promise<void>;
}) {
  const env = content.env;
  const [tab, setTab] = useState<Tab>(env ? "variables" : "source");
  const [editing, setEditing] = useState(false);
  const [reveal, setReveal] = useState<Reveal>({ all: false, lines: new Set() });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [copyToOpen, setCopyToOpen] = useState(false);
  const [sendToOpen, setSendToOpen] = useState(false);
  const [githubOpen, setGithubOpen] = useState(false);
  const [githubRepo, setGithubRepo] = useState<GithubRepoInfo | null>(null);
  const [githubReason, setGithubReason] = useState<string | null>(null);
  const [azureOpen, setAzureOpen] = useState(false);
  const [azureHint, setAzureHint] = useState<AzureHint | null>(null);
  // After a push to one service, offer the same keys to the other. A push started from that
  // offer starts with exactly those keys checked and doesn't offer back.
  const [pushPreset, setPushPreset] = useState<Set<string> | null>(null);
  const [crossPrompt, setCrossPrompt] = useState<CrossPrompt | null>(null);
  const pushed = useRef<{ from: PushService; keys: string[] } | null>(null);

  // A dotenv file with `.git` beside it can be pushed to GitHub; `.azure/config` beside it
  // preselects an Azure app. Detection only reads files.
  const isDotenv = !!env;
  useEffect(() => {
    if (!isDotenv) return;
    let live = true;
    ipc
      .githubRepo(content.path)
      .then((r) => live && (setGithubRepo(r), setGithubReason(null)))
      .catch((e) => live && (setGithubRepo(null), setGithubReason(errorText(e))));
    ipc
      .azureHint(content.path)
      .then((h) => live && setAzureHint(h))
      .catch(() => live && setAzureHint(null));
    return () => {
      live = false;
    };
  }, [content.path, isDotenv]);

  const setPushOpen = (service: PushService, open: boolean) =>
    service === "github" ? setGithubOpen(open) : setAzureOpen(open);

  const openPush = (service: PushService, preset: Set<string> | null = null) => {
    pushed.current = null;
    setPushPreset(preset);
    setPushOpen(service, true);
  };

  const recordPushed = (from: PushService) => (keys: string[]) => {
    const before = pushed.current?.from === from ? pushed.current.keys : [];
    pushed.current = { from, keys: [...before, ...keys] };
  };

  /** Closing a push dialog offers the other service for what was pushed. */
  const pushOpenChange = (service: PushService) => (open: boolean) => {
    setPushOpen(service, open);
    if (open) return;
    const done = pushed.current;
    pushed.current = null;
    const chained = pushPreset !== null;
    setPushPreset(null);
    if (done?.from === service) setCrossPrompt(crossPromptFor(service, done.keys, !!githubRepo, chained));
  };

  const secretCount = useMemo(
    () =>
      env ? pairsOf(env).filter((p) => isSecret(p.key, p.value)).length : structuredSecretLines(content).size,
    [content, env],
  );
  const invalidCount = env ? env.lines.filter((l) => l.type === "other").length : 0;
  const allVars = useMemo(() => (env ? effectiveVars(env) : null), [env]);
  const copyVars = useMemo(
    () => (allVars && selected.size > 0 ? allVars.filter((v) => selected.has(v.key)) : allVars),
    [allVars, selected],
  );

  // `.env.example` without a sibling `.env`: offer to create it.
  const target = templateTarget(content.name);
  const targetPath = target ? joinPath(dirOf(content.path), target) : null;
  const targetMissing = !!targetPath && !!scan && !scan.files.some((f) => f.path === targetPath);

  const toggleLine = (line: number) =>
    setReveal((r) => {
      const lines = new Set(r.lines);
      if (lines.has(line)) lines.delete(line);
      else lines.add(line);
      return { ...r, lines };
    });

  const startEditing = () => {
    setTab("source");
    setEditing(true);
  };

  /** Saves one value edited in the table. Refused if the file changed since it was loaded. */
  const editValue = async (key: string, value: string): Promise<boolean> => {
    try {
      await ipc.setEnvVars(content.path, [{ key, value }], content.modifiedMs);
      toast.success(`Saved ${key}`);
      await afterWrite();
      return true;
    } catch (e) {
      if (errorCode(e) === "STALE") {
        toast.error(errorText(e), { action: { label: "Reload", onClick: () => void afterWrite() } });
      } else {
        toast.error(errorText(e));
      }
      return false;
    }
  };

  const createFromTemplate = async () => {
    try {
      const created = await ipc.createFromTemplate(content.path);
      toast.success(`Created ${target}`, { description: displayPath(created, home) });
      await afterWrite(created);
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  return (
    <Tabs value={tab} onValueChange={(v) => !editing && setTab(v as Tab)} className="flex h-full min-w-0 flex-col gap-0">
      <header className="flex flex-col gap-2 border-b px-5 pt-4 pb-3">
        <div className="flex min-w-0 items-center gap-2">
          <FileIcon kind={content.kind} className="size-5" />
          <h1 className="selectable truncate text-base font-semibold">{content.name}</h1>
          <Badge variant="secondary" className="font-normal">
            {KIND_LABELS[content.kind]}
          </Badge>
          {editing && (
            <Badge variant="outline" className="border-warning font-normal text-warning">
              editing
            </Badge>
          )}
          <div className="ml-auto flex items-center gap-1">
            {secretCount > 0 && !editing && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setReveal((r) => ({ all: !r.all, lines: new Set() }))}
                    aria-pressed={reveal.all}
                    aria-label={reveal.all ? "Hide secrets" : "Reveal secrets"}
                  >
                    {reveal.all ? <EyeOff /> : <Eye />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {reveal.all ? "Hide" : "Reveal"} {secretCount} secret {secretCount === 1 ? "value" : "values"}
                </TooltipContent>
              </Tooltip>
            )}
            <FileActions
              content={content}
              file={file}
              vars={copyVars}
              selectedCount={selected.size}
              copy={copy}
              editing={editing}
              onEdit={startEditing}
              onCopyTo={() => setCopyToOpen(true)}
              onSendTo={() => setSendToOpen(true)}
              onPushToGithub={() => openPush("github")}
              githubRepo={githubRepo}
              githubUnavailable={githubReason}
              onPushToAzure={() => openPush("azure")}
            />
          </div>
        </div>
        <p className="selectable truncate text-xs text-muted-foreground" title={content.path}>
          {displayPath(content.path, home)}
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {env && (
            <TabsList className="h-8">
              <TabsTrigger value="variables" className="text-xs" disabled={editing}>
                Variables
              </TabsTrigger>
              <TabsTrigger value="source" className="text-xs">
                Source
              </TabsTrigger>
              <TabsTrigger value="compare" className="text-xs" disabled={editing}>
                Compare
              </TabsTrigger>
            </TabsList>
          )}
          <span>{formatBytes(content.size)}</span>
          <span>{content.lineEnding.toUpperCase()}</span>
          {content.hasBom && <span>UTF-8 BOM</span>}
          <span title={new Date(content.modifiedMs).toLocaleString()}>Modified {relativeTime(content.modifiedMs)}</span>
          {invalidCount > 0 && (
            <span className="flex items-center gap-1 text-warning">
              <TriangleAlert className="size-3.5" />
              {invalidCount} {invalidCount === 1 ? "line" : "lines"} not parsed
            </span>
          )}
        </div>
        {targetMissing && !editing && (
          <div className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-sm">
            <FilePlus2 className="size-4 shrink-0 text-muted-foreground" />
            <span className="flex-1">
              This template has no <code className="font-mono">{target}</code> next to it yet.
            </span>
            <Button size="sm" variant="outline" onClick={() => void createFromTemplate()}>
              Create {target}
            </Button>
          </div>
        )}
      </header>

      {editing ? (
        <div className="min-h-0 flex-1">
          <SourceEditor
            content={content}
            onDirtyChange={onDirtyChange}
            onCancel={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              void afterWrite();
            }}
            onReload={() => {
              onDirtyChange(false);
              setEditing(false);
              void afterWrite();
            }}
          />
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          {env && (
            <TabsContent value="variables" className="px-3 pb-6">
              <EnvTable
                env={env}
                onCopy={copy.copyText}
                reveal={reveal}
                onToggleReveal={toggleLine}
                selected={selected}
                onSelectedChange={setSelected}
                onEditValue={editValue}
              />
            </TabsContent>
          )}
          <TabsContent value="source" className="py-3">
            <SourceView content={content} reveal={reveal} />
          </TabsContent>
          {env && (
            <TabsContent value="compare">
              <CompareView content={content} scan={scan} revealAll={reveal.all} onWrote={() => void afterWrite()} />
            </TabsContent>
          )}
        </ScrollArea>
      )}

      {copyToOpen && (
        <CopyToDialog
          open={copyToOpen}
          onOpenChange={setCopyToOpen}
          source={content}
          scan={scan}
          home={home}
          onCopied={() => void afterWrite()}
        />
      )}
      {sendToOpen && copyVars && (
        <SendToDialog
          open={sendToOpen}
          onOpenChange={setSendToOpen}
          sourcePath={content.path}
          vars={copyVars}
          scan={scan}
          home={home}
          revealAll={reveal.all}
          onSent={() => void afterWrite()}
        />
      )}
      {githubOpen && githubRepo && allVars && (
        <GithubPushDialog
          open={githubOpen}
          onOpenChange={pushOpenChange("github")}
          sourcePath={content.path}
          repo={githubRepo}
          vars={allVars}
          selected={pushPreset ?? selected}
          revealAll={reveal.all}
          onPushed={recordPushed("github")}
        />
      )}
      {azureOpen && allVars && (
        <AzurePushDialog
          open={azureOpen}
          onOpenChange={pushOpenChange("azure")}
          sourcePath={content.path}
          hint={azureHint}
          vars={allVars}
          selected={pushPreset ?? selected}
          revealAll={reveal.all}
          onPushed={recordPushed("azure")}
        />
      )}
      <AlertDialog open={crossPrompt !== null} onOpenChange={(open) => !open && setCrossPrompt(null)}>
        <AlertDialogContent>
          {crossPrompt && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Also push to {SERVICE_LABELS[crossPrompt.to]}?</AlertDialogTitle>
                <AlertDialogDescription>
                  {crossPrompt.keys.length === 1 ? "This key was" : `These ${crossPrompt.keys.length} keys were`}{" "}
                  pushed. You can push the same {crossPrompt.keys.length === 1 ? "key" : "keys"} to{" "}
                  {crossPrompt.to === "github" && githubRepo
                    ? `${githubRepo.remotes[0].owner}/${githubRepo.remotes[0].name} on GitHub`
                    : "an Azure App Service"}{" "}
                  too. Nothing is sent until you pick where and choose Push.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <p className="selectable line-clamp-3 font-mono text-xs break-all text-muted-foreground">
                {crossPrompt.keys.join(", ")}
              </p>
              <AlertDialogFooter>
                <AlertDialogCancel>Not now</AlertDialogCancel>
                <AlertDialogAction onClick={() => openPush(crossPrompt.to, new Set(crossPrompt.keys))}>
                  Push to {SERVICE_LABELS[crossPrompt.to]}…
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </Tabs>
  );
}

export function FileError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="p-6">
      <Alert variant="destructive">
        <TriangleAlert />
        <AlertTitle>Couldn't open this file</AlertTitle>
        <AlertDescription className="selectable">
          <p>{message}</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={onRetry}>
            <RefreshCw /> Try again
          </Button>
        </AlertDescription>
      </Alert>
    </div>
  );
}
