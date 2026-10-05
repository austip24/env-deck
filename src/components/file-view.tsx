import { useEffect, useMemo, useState } from "react";
import { Eye, EyeOff, FilePlus2, RefreshCw, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { CopyActions } from "@/hooks/use-copy";
import { effectiveVars, isSecret, pairsOf, templateTarget } from "@/lib/env";
import {
  errorText,
  ipc,
  type ConfigContent,
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

  // A dotenv file with `.git` beside it can be pushed to GitHub. Detection only reads files.
  const isDotenv = !!env;
  useEffect(() => {
    if (!isDotenv) return;
    let live = true;
    ipc
      .githubRepo(content.path)
      .then((r) => live && (setGithubRepo(r), setGithubReason(null)))
      .catch((e) => live && (setGithubRepo(null), setGithubReason(errorText(e))));
    return () => {
      live = false;
    };
  }, [content.path, isDotenv]);

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
              onPushToGithub={() => setGithubOpen(true)}
              githubRepo={githubRepo}
              githubUnavailable={githubReason}
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
          onOpenChange={setGithubOpen}
          sourcePath={content.path}
          repo={githubRepo}
          vars={allVars}
          selected={selected}
          revealAll={reveal.all}
        />
      )}
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
