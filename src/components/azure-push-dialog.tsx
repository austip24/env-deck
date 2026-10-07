import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Cloud, Copy, ExternalLink, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  duplicateKeys,
  fieldOf,
  hintedSite,
  initialRows,
  linuxNameNote,
  pushEffects,
  rowProblem,
  rowStatus,
  siteKindLabel,
  summarize,
  toAzureItems,
  type AzureRow,
} from "@/lib/azure";
import { isSecret, MASK, type Var } from "@/lib/env";
import {
  errorCode,
  errorText,
  ipc,
  type AzureAccount,
  type AzureHint,
  type AzurePortalPage,
  type AzureSite,
  type AzureState,
} from "@/lib/ipc";
import { cn } from "@/lib/utils";

/** Select value for the production slot (slot names are letters, digits and -). */
const PRODUCTION = "\u0000production";

type Problem = { code: ReturnType<typeof errorCode>; message: string };

type Load =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; state: AzureState }
  | { status: "error"; message: string };

const isSetupCode = (code: ReturnType<typeof errorCode>) => code === "AZ_AUTH" || code === "AZ_MISSING";

const DEST_LABELS = { appSetting: "App setting", connectionString: "Connection string" } as const;

/**
 * Pushes dotenv keys to an Azure App Service (or one of its deployment slots): app settings,
 * connection strings, general settings and Deployment Center. Rust runs `az` with the user's
 * own `az login` (EnvDeck holds no token) and re-reads the values from disk.
 */
export function AzurePushDialog({
  open,
  onOpenChange,
  sourcePath,
  hint,
  vars,
  selected,
  revealAll,
  onPushed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourcePath: string;
  /** The app `.azure/config` beside the file names, to preselect. */
  hint: AzureHint | null;
  vars: Var[];
  /** Keys to start checked; empty means all. */
  selected: ReadonlySet<string>;
  revealAll: boolean;
  /** Keys that were pushed successfully. */
  onPushed?: (keys: string[]) => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [account, setAccount] = useState<AzureAccount | null>(null);
  const [subscription, setSubscription] = useState("");
  const [sites, setSites] = useState<AzureSite[] | null>(null);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [slots, setSlots] = useState<string[]>([]);
  const [slot, setSlot] = useState<string | null>(null);
  const [load, setLoad] = useState<Load>({ status: "idle" });
  const [rows, setRows] = useState<AzureRow[]>(() => initialRows(vars, selected));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const inspectSeq = useRef(0);

  /** Sign-in and install problems replace the whole dialog body; others are toasts. */
  const fail = useCallback((e: unknown) => {
    const code = errorCode(e);
    if (isSetupCode(code)) setProblem({ code, message: errorText(e) });
    else toast.error(errorText(e));
  }, []);

  useEffect(() => {
    let live = true;
    setProblem(null);
    setAccount(null);
    ipc
      .azureAccount()
      .then((a) => {
        if (!live) return;
        setAccount(a);
        setSubscription((s) => (a.subscriptions.some((x) => x.id === s) ? s : (a.subscriptions[0]?.id ?? "")));
      })
      .catch((e) => live && setProblem({ code: errorCode(e), message: errorText(e) }));
    return () => {
      live = false;
    };
  }, [attempt]);

  useEffect(() => {
    if (!account || !subscription) return;
    let live = true;
    setSites(null);
    ipc
      .azureListApps(subscription)
      .then((list) => {
        if (!live) return;
        setSites(list);
        setSiteId((cur) => (cur && list.some((s) => s.id === cur) ? cur : (hintedSite(list, hint)?.id ?? null)));
      })
      .catch((e) => {
        if (!live) return;
        setSites([]);
        fail(e);
      });
    return () => {
      live = false;
    };
  }, [account, subscription, hint, fail]);

  useEffect(() => {
    setSlots([]);
    setSlot(null);
    if (!siteId) return;
    let live = true;
    ipc
      .azureListSlots(siteId)
      .then((s) => live && setSlots(s))
      .catch((e) => live && fail(e));
    return () => {
      live = false;
    };
  }, [siteId, fail]);

  const inspect = useCallback(
    async (quiet = false) => {
      const seq = ++inspectSeq.current;
      if (!siteId) {
        setLoad({ status: "idle" });
        return;
      }
      if (!quiet) setLoad({ status: "loading" });
      try {
        const state = await ipc.azureInspect(siteId, slot);
        if (seq === inspectSeq.current) setLoad({ status: "ready", state });
      } catch (e) {
        if (seq !== inspectSeq.current) return;
        const code = errorCode(e);
        if (isSetupCode(code)) setProblem({ code, message: errorText(e) });
        else setLoad({ status: "error", message: errorText(e) });
      }
    },
    [siteId, slot],
  );

  useEffect(() => {
    void inspect();
  }, [inspect]);

  const site = sites?.find((s) => s.id === siteId);
  const state = load.status === "ready" ? load.state : null;
  const fields = state?.fields ?? [];
  const general = fields.filter((f) => f.section === "general");
  const deployment = fields.filter((f) => f.section === "deployment");
  const dupes = duplicateKeys(rows, fields);
  const summary = state ? summarize(rows, state) : { count: 0, replace: 0 };
  const effects = pushEffects(rows, fields);
  const checkable = rows.filter((r) => rowProblem(r, fields) === null);
  const checkedCount = checkable.filter((r) => r.checked).length;
  const targetName = site ? `${site.name}${slot ? `/${slot}` : ""}` : "";

  const update = (key: string, change: Partial<AzureRow>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...change } : r)));
  const updateChecked = (change: Partial<AzureRow>) =>
    setRows((rs) => rs.map((r) => (r.checked ? { ...r, ...change } : r)));

  const openPortal = (page: AzurePortalPage) => {
    if (siteId) void ipc.azureOpenPortal(siteId, slot, page).catch((e) => toast.error(errorText(e)));
  };

  const push = async () => {
    if (!state || !siteId || summary.count === 0) return;
    setBusy(true);
    setErrors({});
    try {
      const results = await ipc.azurePush(sourcePath, siteId, slot, toAzureItems(rows, fields));
      const failed = results.filter((r) => r.error !== null);
      const ok = results.filter((r) => r.error === null).map((r) => r.key);
      if (ok.length > 0) onPushed?.(ok);
      if (failed.length === 0) {
        toast.success(`Pushed ${ok.length} to ${targetName}`);
        onOpenChange(false);
        return;
      }
      if (ok.length > 0) toast.success(`Pushed ${ok.length} to ${targetName}`);
      toast.error(`${failed.length} of ${results.length} couldn't be pushed`);
      setErrors(Object.fromEntries(failed.map((r) => [r.key, r.error ?? ""])));
      // Leave only the failures checked, so "Push" retries just those.
      const failedKeys = new Set(failed.map((r) => r.key));
      setRows((rs) => rs.map((r) => ({ ...r, checked: r.checked && failedKeys.has(r.key) })));
      await inspect(true);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const show = (row: AzureRow) =>
    revealAll || (!isSecret(row.key, row.value) && !fieldOf(row, fields)?.secret) ? row.value || "(empty)" : MASK;

  const destValue = (row: AzureRow) => (row.dest === "field" ? `field:${row.fieldId ?? ""}` : row.dest);
  const setDest = (key: string, v: string) =>
    update(
      key,
      v.startsWith("field:")
        ? { dest: "field", fieldId: v.slice(6) }
        : { dest: v as AzureRow["dest"], fieldId: null },
    );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Cloud className="size-4" /> Push to Azure App Service
            {site && (
              <Badge variant="secondary" className="selectable font-mono font-normal">
                {targetName}
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-x-1">
            <span>Sets app settings, connection strings and configuration. Values are read from the file on disk.</span>
            {account && (
              <span className="ml-auto text-xs" title="The account from az login. Switch with az login or az account set.">
                Using Azure CLI as <span className="selectable font-medium text-foreground">{account.user}</span>
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        {problem ? (
          <AzProblem problem={problem} onRetry={() => setAttempt((n) => n + 1)} />
        ) : !account ? (
          <div className="flex h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Checking the Azure CLI sign-in…
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {account.subscriptions.length > 1 && (
                <Select value={subscription} onValueChange={setSubscription} disabled={busy}>
                  <SelectTrigger size="sm" className="max-w-56 min-w-40" aria-label="Subscription">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {account.subscriptions.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Select value={siteId ?? ""} onValueChange={setSiteId} disabled={busy || !sites || sites.length === 0}>
                <SelectTrigger size="sm" className="max-w-72 min-w-56" aria-label="App">
                  <SelectValue
                    placeholder={sites === null ? "Loading apps…" : sites.length === 0 ? "No apps in this subscription" : "Choose an app"}
                  />
                </SelectTrigger>
                <SelectContent>
                  {sites?.map((s) => (
                    <SelectItem key={s.id} value={s.id} title={`${s.resourceGroup} · ${siteKindLabel(s.kind)} · ${s.location}`}>
                      {s.name} · {s.resourceGroup}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {siteId && (
                <Select value={slot ?? PRODUCTION} onValueChange={(v) => setSlot(v === PRODUCTION ? null : v)} disabled={busy}>
                  <SelectTrigger size="sm" className="min-w-36" aria-label="Slot">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={PRODUCTION}>Production</SelectItem>
                    {slots.length > 0 && <SelectSeparator />}
                    {slots.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {hint?.web && !hintedSite(sites ?? [], hint) && sites !== null && (
                <span className="text-xs text-muted-foreground">
                  .azure/config names {hint.web}, which isn't in this subscription
                </span>
              )}
            </div>

            {load.status === "idle" && (
              <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
                Choose the app to push to.
              </div>
            )}

            {load.status === "loading" && (
              <div className="flex h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Reading the app's settings…
              </div>
            )}

            {load.status === "error" && (
              <Alert variant="destructive">
                <TriangleAlert />
                <AlertTitle>Couldn't read the app</AlertTitle>
                <AlertDescription className="selectable space-y-2">
                  <p className="break-words">{load.message}</p>
                  <Button variant="outline" size="sm" onClick={() => void inspect()}>
                    <RefreshCw /> Try again
                  </Button>
                </AlertDescription>
              </Alert>
            )}

            {state && (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Checkbox
                    aria-label="Select all"
                    className="ml-2"
                    checked={checkedCount === 0 ? false : checkedCount === checkable.length ? true : "indeterminate"}
                    onCheckedChange={(v) =>
                      setRows((rs) => rs.map((r) => ({ ...r, checked: v === true && rowProblem(r, fields) === null })))
                    }
                  />
                  <span className="text-xs text-muted-foreground">
                    {checkedCount} of {rows.length} selected
                  </span>
                  <div className="ml-auto flex items-center gap-2">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="sm">
                          <ExternalLink /> Portal
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => openPortal("environment")}>Environment variables</DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => openPortal("configuration")}>Configuration</DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => openPortal("deploymentCenter")}>Deployment Center</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <Button variant="ghost" size="icon-sm" aria-label="Refresh from Azure" onClick={() => void inspect(true)}>
                      <RefreshCw />
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="sm" disabled={checkedCount === 0}>
                          Set selected <ChevronDown />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => updateChecked({ dest: "appSetting", fieldId: null })}>
                          As app settings
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => updateChecked({ dest: "connectionString", fieldId: null })}>
                          As connection strings
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                          Slot setting (stays with the slot on swap)
                        </DropdownMenuLabel>
                        <DropdownMenuItem onSelect={() => updateChecked({ slotSetting: true })}>On</DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => updateChecked({ slotSetting: false })}>Off</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>

                <ScrollArea className="h-80 rounded-md border">
                  <ul className="divide-y">
                    {rows.map((row) => {
                      const problem = rowProblem(row, fields);
                      const field = fieldOf(row, fields);
                      const dupe = dupes.has(row.key);
                      const status = rowStatus(row, state);
                      const named = row.dest !== "field";
                      const nameNote = named && state.linux ? linuxNameNote(row.name) : null;
                      return (
                        <li key={row.key} className={cn("px-2 py-1.5", problem && "text-muted-foreground")}>
                          <div className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)_12rem_7rem_auto_5.5rem] items-center gap-2">
                            <Checkbox
                              aria-label={`Push ${row.key}`}
                              checked={row.checked && problem === null}
                              disabled={problem !== null}
                              onCheckedChange={(v) => update(row.key, { checked: v === true })}
                            />
                            <span className="selectable truncate font-mono text-xs" title={row.key}>
                              {row.key}
                              {named && row.name !== row.key && (
                                <span className="text-muted-foreground"> as {row.name}</span>
                              )}
                            </span>
                            <span className="truncate font-mono text-xs text-muted-foreground">{show(row)}</span>
                            <Select value={destValue(row)} onValueChange={(v) => setDest(row.key, v)}>
                              <SelectTrigger size="sm" className="h-7 w-full text-xs" aria-label={`${row.key} destination`}>
                                <SelectValue placeholder="Choose…">
                                  {row.dest === "field" ? (field?.label ?? "Choose…") : DEST_LABELS[row.dest]}
                                </SelectValue>
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="appSetting">App setting</SelectItem>
                                <SelectItem value="connectionString">Connection string</SelectItem>
                                <SelectSeparator />
                                <SelectGroup>
                                  <SelectLabel>General settings</SelectLabel>
                                  {general.map((f) => (
                                    <SelectItem key={f.id} value={`field:${f.id}`}>
                                      {f.label}
                                    </SelectItem>
                                  ))}
                                </SelectGroup>
                                <SelectSeparator />
                                <SelectGroup>
                                  <SelectLabel>Deployment Center</SelectLabel>
                                  {deployment.map((f) => (
                                    <SelectItem key={f.id} value={`field:${f.id}`}>
                                      {f.label}
                                    </SelectItem>
                                  ))}
                                </SelectGroup>
                              </SelectContent>
                            </Select>
                            {row.dest === "connectionString" ? (
                              <Select value={row.connType} onValueChange={(v) => update(row.key, { connType: v })}>
                                <SelectTrigger size="sm" className="h-7 w-full text-xs" aria-label={`${row.key} type`}>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {state.connectionTypes.map((t) => (
                                    <SelectItem key={t} value={t}>
                                      {t}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            ) : (
                              <span />
                            )}
                            <label
                              className={cn("flex items-center gap-1 text-xs text-muted-foreground", !named && "invisible")}
                              title="Slot setting: stays with this slot when slots are swapped"
                            >
                              <Checkbox
                                aria-label={`${row.key} slot setting`}
                                checked={row.slotSetting}
                                disabled={!named}
                                onCheckedChange={(v) => update(row.key, { slotSetting: v === true })}
                              />
                              Slot
                            </label>
                            <span className="flex justify-end">
                              {problem || dupe ? (
                                <Badge variant="outline" title={problem ?? "Another row already sets this"}>
                                  skipped
                                </Badge>
                              ) : status === "replaces" ? (
                                <Badge className="bg-warning text-warning-foreground" title="Overwrites the existing value">
                                  replaces
                                </Badge>
                              ) : status === "updates" ? (
                                <Badge variant="secondary" title="Changes the app's current setting">
                                  updates
                                </Badge>
                              ) : (
                                <Badge className="bg-success text-success-foreground">new</Badge>
                              )}
                            </span>
                          </div>
                          {problem && <p className="mt-0.5 pl-6 text-xs">{problem}</p>}
                          {!problem && dupe && row.checked && (
                            <p className="mt-0.5 pl-6 text-xs">Another row already sets this</p>
                          )}
                          {!problem && nameNote && <p className="mt-0.5 pl-6 text-xs text-warning">{nameNote}</p>}
                          {!problem && field?.note && <p className="mt-0.5 pl-6 text-xs text-warning">{field.note}</p>}
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
          </>
        )}

        <DialogFooter className="sm:items-center">
          {effects.restarts && state && (
            <p className="mr-auto flex items-center gap-1.5 text-xs text-muted-foreground">
              <TriangleAlert className="size-3.5 shrink-0 text-warning" />
              Saving restarts the app{effects.redeploys ? " and changing the source starts a deployment" : ""}.
            </p>
          )}
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

function AzProblem({ problem, onRetry }: { problem: Problem; onRetry: () => void }) {
  const setup = isSetupCode(problem.code);
  return (
    <Alert variant={setup ? "default" : "destructive"}>
      <TriangleAlert />
      <AlertTitle>
        {problem.code === "AZ_MISSING"
          ? "Azure CLI not found"
          : problem.code === "AZ_AUTH"
            ? "Azure CLI isn't signed in"
            : "Couldn't reach Azure"}
      </AlertTitle>
      <AlertDescription className="selectable space-y-2">
        {problem.code === "AZ_MISSING" ? (
          <p>
            EnvDeck runs the Azure CLI (<code>az</code>) with your own Azure login to change App Service settings.
            Install it from aka.ms/azcli, sign in once in a terminal, then try again:
          </p>
        ) : problem.code === "AZ_AUTH" ? (
          <p>
            EnvDeck uses the Azure CLI's login, so it works on any app you can already change. Sign in once in a
            terminal, then try again:
          </p>
        ) : (
          <p className="break-words">{problem.message}</p>
        )}
        {setup && <AzLoginCommand />}
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw /> Try again
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

const AZ_LOGIN = "az login";

function AzLoginCommand() {
  const copy = () =>
    void ipc
      .writeClipboardText(AZ_LOGIN)
      .then(() => toast.success("Copied command"))
      .catch((e) => toast.error(errorText(e)));
  return (
    <div className="flex items-center gap-1">
      <code className="selectable rounded-md bg-muted px-2 py-1 font-mono text-xs text-foreground">{AZ_LOGIN}</code>
      <Button variant="ghost" size="icon-sm" aria-label="Copy command" onClick={copy}>
        <Copy />
      </Button>
    </div>
  );
}
