import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ExternalLink, GitBranch, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { GithubSignIn } from "@/components/github-sign-in";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { isSecret, MASK, type Var } from "@/lib/env";
import {
  initialRows,
  rowProblem,
  rowStatus,
  summarize,
  targetLabel,
  toPushItems,
  type PushRow,
} from "@/lib/github";
import {
  errorCode,
  errorText,
  ipc,
  type GithubAccount,
  type GithubKind,
  type GithubRepoInfo,
  type GithubState,
} from "@/lib/ipc";
import { cn } from "@/lib/utils";

/** Select value for the repository itself (environment names can't contain control characters). */
const REPO = "\u0000repository";
const toTarget = (v: string) => (v === REPO ? null : v);
const fromTarget = (t: string | null) => t ?? REPO;

type Load =
  | { status: "loading" }
  | { status: "signIn"; reason: string | null }
  | { status: "ready"; state: GithubState }
  | { status: "error"; code: ReturnType<typeof errorCode>; message: string };

/**
 * Pushes dotenv keys to GitHub Actions secrets or variables, per key, for the repository or one
 * of its existing environments. The user signs in to the EnvDeck GitHub App (memory only); Rust
 * then runs `gh` with that token and re-reads the values from disk. EnvDeck can't create
 * environments (that needs repository admin rights), so it links to the repository's settings.
 */
export function GithubPushDialog({
  open,
  onOpenChange,
  sourcePath,
  repo,
  vars,
  selected,
  revealAll,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourcePath: string;
  repo: GithubRepoInfo;
  vars: Var[];
  /** Keys selected in the table; empty means all. */
  selected: ReadonlySet<string>;
  revealAll: boolean;
}) {
  const [remoteName, setRemoteName] = useState(repo.remotes[0]?.remote ?? "");
  const remote = repo.remotes.find((r) => r.remote === remoteName) ?? repo.remotes[0];
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [account, setAccount] = useState<GithubAccount | null>(null);
  const [rows, setRows] = useState<PushRow[]>(() => initialRows(vars, selected));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const needSignIn = (reason: string | null) => {
    setAccount((a) => a && { ...a, login: null });
    setLoad({ status: "signIn", reason });
  };

  const signOut = async () => {
    try {
      setAccount(await ipc.githubSignOut());
      setLoad({ status: "signIn", reason: null });
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  const inspect = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoad({ status: "loading" });
      try {
        const acct = await ipc.githubAccount();
        setAccount(acct);
        if (!acct.login) {
          setLoad({ status: "signIn", reason: null });
          return;
        }
        const state = await ipc.githubInspect(sourcePath, remoteName);
        setLoad({ status: "ready", state });
      } catch (e) {
        if (errorCode(e) === "GH_AUTH") needSignIn(errorText(e));
        else
          setLoad({
            status: "error",
            code: errorCode(e),
            message: errorText(e),
          });
      }
    },
    [sourcePath, remoteName],
  );

  useEffect(() => {
    void inspect();
  }, [inspect]);

  const state = load.status === "ready" ? load.state : null;
  const environments = state?.environments ?? [];
  const summary = state ? summarize(rows, state) : { count: 0, replace: 0 };
  const checkable = rows.filter((r) => rowProblem(r) === null);
  const checkedCount = checkable.filter((r) => r.checked).length;

  const update = (key: string, change: Partial<PushRow>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...change } : r)));
  const updateChecked = (change: Partial<PushRow>) =>
    setRows((rs) => rs.map((r) => (r.checked ? { ...r, ...change } : r)));

  const openPage = (page: "install" | "environments") =>
    void ipc.githubOpenPage(sourcePath, remoteName, page).catch((e) => toast.error(errorText(e)));

  const push = async () => {
    if (!state || summary.count === 0) return;
    setBusy(true);
    setErrors({});
    try {
      const results = await ipc.githubPush(sourcePath, remoteName, toPushItems(rows));
      const failed = results.filter((r) => r.error !== null);
      const ok = results.length - failed.length;
      if (failed.length === 0) {
        toast.success(`Pushed ${ok} to ${state.repo}`);
        onOpenChange(false);
        return;
      }
      if (ok > 0) toast.success(`Pushed ${ok} to ${state.repo}`);
      toast.error(`${failed.length} of ${results.length} couldn't be pushed`);
      setErrors(Object.fromEntries(failed.map((r) => [r.key, r.error ?? ""])));
      // Leave only the failures checked, so "Push" retries just those.
      const failedKeys = new Set(failed.map((r) => r.key));
      setRows((rs) => rs.map((r) => ({ ...r, checked: r.checked && failedKeys.has(r.key) })));
      await inspect(true);
    } catch (e) {
      const code = errorCode(e);
      if (code === "GH_AUTH") needSignIn(errorText(e));
      else if (code === "GH_MISSING" || code === "GH_NOT_INSTALLED") setLoad({ status: "error", code, message: errorText(e) });
      else toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const show = (key: string, value: string) => (revealAll || !isSecret(key, value) ? value || "(empty)" : MASK);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="size-4" /> Push to GitHub
            {remote && (
              <Badge variant="secondary" className="selectable font-mono font-normal">
                {remote.host === "github.com" ? "" : `${remote.host}/`}
                {remote.owner}/{remote.name}
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-x-1">
            <span>Sets Actions secrets or variables. Values are read from the file on disk.</span>
            {account?.login && (
              <span className="ml-auto flex items-center gap-1 text-xs">
                Signed in as <span className="selectable font-medium text-foreground">@{account.login}</span>
                <Button variant="link" size="xs" className="h-auto px-1" onClick={() => void signOut()} disabled={busy}>
                  Sign out
                </Button>
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        {repo.remotes.length > 1 && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Remote</span>
            <Select value={remoteName} onValueChange={setRemoteName} disabled={busy}>
              <SelectTrigger size="sm" className="min-w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {repo.remotes.map((r) => (
                  <SelectItem key={r.remote} value={r.remote}>
                    {r.remote} · {r.owner}/{r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {load.status === "loading" && (
          <div className="flex h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Checking the repository on GitHub…
          </div>
        )}

        {load.status === "signIn" && account && (
          <GithubSignIn account={account} reason={load.reason} onSignedIn={() => void inspect()} />
        )}

        {load.status === "error" && (
          <GhProblem
            code={load.code}
            message={load.message}
            repo={remote ? `${remote.owner}/${remote.name}` : ""}
            onInstall={() => openPage("install")}
            onRetry={() => void inspect()}
          />
        )}

        {state && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Checkbox
                aria-label="Select all"
                className="ml-2"
                checked={checkedCount === 0 ? false : checkedCount === checkable.length ? true : "indeterminate"}
                onCheckedChange={(v) =>
                  setRows((rs) =>
                    rs.map((r) => ({
                      ...r,
                      checked: v === true && rowProblem(r) === null,
                    })),
                  )
                }
              />
              <span className="text-xs text-muted-foreground">
                {checkedCount} of {rows.length} selected
              </span>
              <div className="ml-auto flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => openPage("environments")}>
                  <ExternalLink /> Manage environments
                </Button>
                <Button variant="ghost" size="icon-sm" aria-label="Refresh from GitHub" onClick={() => void inspect(true)}>
                  <RefreshCw />
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" disabled={checkedCount === 0}>
                      Set selected <ChevronDown />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => updateChecked({ kind: "secret" })}>As secrets</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => updateChecked({ kind: "variable" })}>
                      As variables
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Target</DropdownMenuLabel>
                    <DropdownMenuItem onSelect={() => updateChecked({ target: null })}>Repository</DropdownMenuItem>
                    {environments.map((env) => (
                      <DropdownMenuItem key={env} onSelect={() => updateChecked({ target: env })}>
                        {env}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>

            <ScrollArea className="h-80 rounded-md border">
              <ul className="divide-y">
                {rows.map((row) => {
                  const problem = rowProblem(row);
                  const status = rowStatus(row, state);
                  return (
                    <li key={row.key} className={cn("px-2 py-1.5", problem && "text-muted-foreground")}>
                      <div className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)_7rem_9rem_5.5rem] items-center gap-2">
                        <Checkbox
                          aria-label={`Push ${row.key}`}
                          checked={row.checked}
                          disabled={problem !== null}
                          onCheckedChange={(v) => update(row.key, { checked: v === true })}
                        />
                        <span className="selectable truncate font-mono text-xs" title={row.key}>
                          {row.key}
                        </span>
                        <span className="truncate font-mono text-xs text-muted-foreground">
                          {show(row.key, row.value)}
                        </span>
                        <Select
                          value={row.kind}
                          onValueChange={(v) => update(row.key, { kind: v as GithubKind })}
                          disabled={problem !== null}
                        >
                          <SelectTrigger size="sm" className="h-7 w-full text-xs" aria-label={`${row.key} kind`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="secret">Secret</SelectItem>
                            <SelectItem value="variable">Variable</SelectItem>
                          </SelectContent>
                        </Select>
                        <Select
                          value={fromTarget(row.target)}
                          onValueChange={(v) => update(row.key, { target: toTarget(v) })}
                          disabled={problem !== null}
                        >
                          <SelectTrigger size="sm" className="h-7 w-full text-xs" aria-label={`${row.key} target`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={REPO}>{targetLabel(null)}</SelectItem>
                            {environments.length > 0 && <SelectSeparator />}
                            {environments.map((env) => (
                              <SelectItem key={env} value={env}>
                                {env}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <span className="flex justify-end">
                          {problem ? (
                            <Badge variant="outline" title={problem}>
                              skipped
                            </Badge>
                          ) : status === "replaces" ? (
                            <Badge className="bg-warning text-warning-foreground" title="Overwrites the existing value">
                              replaces
                            </Badge>
                          ) : (
                            <Badge className="bg-success text-success-foreground">new</Badge>
                          )}
                        </span>
                      </div>
                      {problem && <p className="mt-0.5 pl-6 text-xs">{problem}</p>}
                      {errors[row.key] && (
                        <p className="selectable mt-0.5 pl-6 text-xs break-words text-destructive">{errors[row.key]}</p>
                      )}
                    </li>
                  );
                })}
              </ul>
            </ScrollArea>

            {state.warnings.length > 0 && (
              <ul className="selectable space-y-0.5 text-xs text-warning">
                {state.warnings.map((w) => (
                  <li key={w} className="flex gap-1.5">
                    <TriangleAlert className="mt-0.5 size-3 shrink-0" />
                    <span className="break-words">{w}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void push()} disabled={!state || summary.count === 0 || busy}>
            {busy && <Loader2 className="animate-spin" />}
            {summary.count === 0
              ? "Nothing selected"
              : `Push ${summary.count}${summary.replace ? ` (${summary.replace} replace)` : ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GhProblem({
  code,
  message,
  repo,
  onInstall,
  onRetry,
}: {
  code: ReturnType<typeof errorCode>;
  message: string;
  /** `owner/name`. */
  repo: string;
  onInstall: () => void;
  onRetry: () => void;
}) {
  const notInstalled = code === "GH_NOT_INSTALLED";
  return (
    <Alert variant={code === "GH_MISSING" || notInstalled ? "default" : "destructive"}>
      <TriangleAlert />
      <AlertTitle>
        {code === "GH_MISSING"
          ? "GitHub CLI not found"
          : notInstalled
            ? `EnvDeck isn't installed on ${repo}`
            : "Couldn't read the repository"}
      </AlertTitle>
      <AlertDescription className="selectable space-y-2">
        {code === "GH_MISSING" ? (
          <p>
            EnvDeck runs the GitHub CLI (<code>gh</code>) with your GitHub sign-in to set secrets and variables. Install
            it from cli.github.com (no <code>gh auth login</code> needed), then try again.
          </p>
        ) : notInstalled ? (
          <p>
            EnvDeck can only reach repositories where its GitHub App is installed. Install it on {repo} (or on all your
            repositories), then try again. For an organization's repository, an owner may need to approve the request.
          </p>
        ) : (
          <p className="break-words">{message}</p>
        )}
        <div className="flex gap-2">
          {notInstalled && (
            <Button size="sm" onClick={onInstall}>
              <ExternalLink /> Install on GitHub
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw /> Try again
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
