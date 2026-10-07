import { useMemo, useRef, useState, type Dispatch, type KeyboardEvent, type SetStateAction } from "react";
import { Eye, EyeOff, Loader2, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { isSecret, MASK, overriddenLines, quoteDotenv } from "@/lib/env";
import type { EnvLine, ParsedEnv } from "@/lib/ipc";
import { isMac, isModKey } from "@/lib/platform";
import { cn } from "@/lib/utils";

type Row =
  | { kind: "pair"; line: Extract<EnvLine, { type: "pair" }>; overridden: boolean; secret: boolean }
  | { kind: "other"; line: Extract<EnvLine, { type: "other" }> };

export interface Reveal {
  all: boolean;
  /** Start lines of individually revealed values. */
  lines: Set<number>;
}

export function isRevealed(reveal: Reveal, line: number): boolean {
  return reveal.all || reveal.lines.has(line);
}

export function EnvTable({
  env,
  reveal,
  onToggleReveal,
  selected,
  onSelectedChange,
  onCopy,
  onEditValue,
}: {
  env: ParsedEnv;
  /** Copies text to the clipboard; `what` names it in the toast. */
  onCopy: (text: string, what: string) => void;
  reveal: Reveal;
  onToggleReveal: (line: number) => void;
  selected: Set<string>;
  onSelectedChange: Dispatch<SetStateAction<Set<string>>>;
  /** Saves a new value for a key (double-click a value); resolves false if it wasn't saved. */
  onEditValue?: (key: string, value: string) => Promise<boolean>;
}) {
  const rows = useMemo<Row[]>(() => {
    const overridden = overriddenLines(env);
    return env.lines.flatMap((l): Row[] => {
      if (l.type === "pair") {
        return [{ kind: "pair", line: l, overridden: overridden.has(l.startLine), secret: isSecret(l.key, l.value) }];
      }
      if (l.type === "other") return [{ kind: "other", line: l }];
      return [];
    });
  }, [env]);

  // Selection is by key, over effective (non-overridden) definitions.
  const selectable = useMemo(
    () => rows.flatMap((r) => (r.kind === "pair" && !r.overridden ? [r.line.key] : [])),
    [rows],
  );
  const lastClicked = useRef<number | null>(null);
  const allSelected = selectable.length > 0 && selectable.every((k) => selected.has(k));
  const someSelected = selectable.some((k) => selected.has(k));

  const toggleKey = (key: string, shift: boolean) => {
    const index = selectable.indexOf(key);
    const from = shift && lastClicked.current !== null ? lastClicked.current : index;
    lastClicked.current = index;
    // Functional update so quick successive clicks don't drop each other.
    onSelectedChange((prev) => {
      const next = new Set(prev);
      const on = !prev.has(key);
      const [a, b] = [from, index].sort((x, y) => x - y);
      for (const k of selectable.slice(a, b + 1)) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  };

  if (rows.length === 0) {
    return <p className="p-6 text-sm text-muted-foreground">This file defines no variables.</p>;
  }

  return (
    <Table className="table-fixed">
      <TableHeader className="sticky top-0 z-10 bg-background">
        <TableRow>
          <TableHead className="w-10 [&>[role=checkbox]]:translate-y-0">
            <Checkbox
              aria-label="Select all variables"
              checked={allSelected ? true : someSelected ? "indeterminate" : false}
              onCheckedChange={() => onSelectedChange(allSelected ? new Set() : new Set(selectable))}
            />
          </TableHead>
          <TableHead className="w-[38%]">Key</TableHead>
          <TableHead>Value</TableHead>
          <TableHead className="w-12 text-right">Line</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) =>
          row.kind === "other" ? (
            <TableRow key={`o${row.line.startLine}`} className="bg-warning/5 hover:bg-warning/10">
              <TableCell>
                <TriangleAlert className="size-4 text-warning" aria-label="Not parsed" />
              </TableCell>
              <TableCell colSpan={2} className="whitespace-normal">
                <code className="selectable block truncate font-mono text-xs">{row.line.raw}</code>
                <span className="text-xs text-warning">Not parsed: {row.line.reason}</span>
              </TableCell>
              <TableCell className="text-right text-xs text-muted-foreground tabular-nums">
                {row.line.startLine}
              </TableCell>
            </TableRow>
          ) : (
            <PairRow
              key={`p${row.line.startLine}`}
              row={row}
              revealed={isRevealed(reveal, row.line.startLine)}
              onToggleReveal={() => onToggleReveal(row.line.startLine)}
              checked={!row.overridden && selected.has(row.line.key)}
              onCheck={(shift) => toggleKey(row.line.key, shift)}
              onCopy={onCopy}
              // The overridden (earlier) definition isn't the one an upsert writes.
              onEdit={onEditValue && !row.overridden ? (value) => onEditValue(row.line.key, value) : undefined}
            />
          ),
        )}
      </TableBody>
    </Table>
  );
}

function PairRow({
  row,
  revealed,
  onToggleReveal,
  checked,
  onCheck,
  onCopy,
  onEdit,
}: {
  row: Extract<Row, { kind: "pair" }>;
  revealed: boolean;
  onToggleReveal: () => void;
  checked: boolean;
  onCheck: (shift: boolean) => void;
  onCopy: (text: string, what: string) => void;
  onEdit?: (value: string) => Promise<boolean>;
}) {
  const { line, overridden, secret } = row;
  const masked = secret && !revealed;
  // The value being edited, or null. Editing shows the raw value, even for a masked secret:
  // double-clicking is the explicit action, and it's masked again once saved or cancelled.
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Enter/Escape then blur would finish twice; only the first counts.
  const finished = useRef(false);
  const multiline = draft !== null && (draft.includes("\n") || line.value.includes("\n"));

  // Choosing "Edit value" in the context menu mustn't hand focus back to the row.
  const editFromMenu = useRef(false);

  const startEdit = () => {
    if (!onEdit || draft !== null) return;
    finished.current = false;
    setDraft(line.value);
  };

  const finish = async (save: boolean) => {
    if (finished.current || draft === null) return;
    finished.current = true;
    if (!save || draft === line.value) {
      setDraft(null);
      return;
    }
    setSaving(true);
    const ok = await onEdit!(draft);
    setSaving(false);
    // On failure (e.g. the file changed on disk) keep the draft; Escape discards it.
    if (ok) setDraft(null);
    else finished.current = false;
  };

  const onEditorKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      void finish(false);
    } else if (e.key === "Enter" && (multiline ? isModKey(e) : !e.shiftKey)) {
      e.preventDefault();
      void finish(true);
    }
  };
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <TableRow data-state={checked ? "selected" : undefined} className={cn(overridden && "opacity-55")}>
          <TableCell className="[&>[role=checkbox]]:translate-y-0">
            {!overridden && (
              <Checkbox
                aria-label={`Select ${line.key}`}
                checked={checked}
                onClick={(e) => {
                  e.preventDefault();
                  onCheck(e.shiftKey);
                }}
              />
            )}
          </TableCell>
          <TableCell>
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="selectable truncate font-mono text-[13px]" title={line.key}>
                {line.key}
              </span>
              {line.export && (
                <Badge variant="outline" className="h-4 px-1 font-normal text-[10px]">
                  export
                </Badge>
              )}
              {overridden && (
                <Badge variant="outline" className="h-4 px-1 font-normal text-[10px]">
                  overridden
                </Badge>
              )}
            </div>
          </TableCell>
          <TableCell className="whitespace-normal" onDoubleClick={startEdit}>
            {draft !== null ? (
              <div className="flex flex-col gap-1">
                {multiline ? (
                  <Textarea
                    autoFocus
                    aria-label={`Value of ${line.key}`}
                    value={draft}
                    disabled={saving}
                    rows={Math.min(8, draft.split("\n").length + 1)}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={onEditorKey}
                    onBlur={() => void finish(true)}
                    className="selectable min-h-0 font-mono text-[13px]"
                  />
                ) : (
                  <Input
                    autoFocus
                    aria-label={`Value of ${line.key}`}
                    value={draft}
                    disabled={saving}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={onEditorKey}
                    onBlur={() => void finish(true)}
                    onFocus={(e) => e.target.select()}
                    className="selectable h-7 font-mono text-[13px]"
                  />
                )}
                <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  {saving && <Loader2 className="size-3 animate-spin" />}
                  {multiline ? (isMac ? "⌘Enter" : "Ctrl+Enter") : "Enter"} to save · Esc to cancel
                </span>
              </div>
            ) : (
              <div
                className={cn("flex min-w-0 items-center gap-1", onEdit && "cursor-text")}
                title={onEdit ? "Double-click to edit" : undefined}
              >
                <div className="min-w-0 flex-1 font-mono text-[13px]">
                  {line.value === "" ? (
                    <span className="text-muted-foreground italic">empty</span>
                  ) : masked ? (
                    <span className="text-muted-foreground tracking-widest" aria-label="Hidden value">
                      {MASK}
                    </span>
                  ) : (
                    <span className="selectable line-clamp-4 break-all whitespace-pre-wrap">{line.value}</span>
                  )}
                  {line.inlineComment && (
                    <span className="selectable ml-2 text-xs text-muted-foreground">{line.inlineComment}</span>
                  )}
                </div>
                {secret && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={onToggleReveal}
                    onDoubleClick={(e) => e.stopPropagation()}
                    aria-label={revealed ? `Hide ${line.key}` : `Reveal ${line.key}`}
                    className="text-muted-foreground"
                  >
                    {revealed ? <EyeOff /> : <Eye />}
                  </Button>
                )}
              </div>
            )}
          </TableCell>
          <TableCell className="text-right text-xs text-muted-foreground tabular-nums">
            {line.startLine}
          </TableCell>
        </TableRow>
      </ContextMenuTrigger>
      <ContextMenuContent
        onCloseAutoFocus={(e) => {
          if (editFromMenu.current) e.preventDefault();
          editFromMenu.current = false;
        }}
      >
        {onEdit && (
          <>
            <ContextMenuItem
              onSelect={() => {
                editFromMenu.current = true;
                startEdit();
              }}
            >
              Edit value
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        <ContextMenuItem onSelect={() => onCopy(line.value, `value of ${line.key}`)}>Copy value</ContextMenuItem>
        <ContextMenuItem onSelect={() => onCopy(line.key, "key")}>Copy key</ContextMenuItem>
        <ContextMenuItem onSelect={() => onCopy(`${line.key}=${quoteDotenv(line.value)}`, `${line.key}=…`)}>
          Copy as KEY=value
        </ContextMenuItem>
        {secret && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={onToggleReveal}>{revealed ? "Hide value" : "Reveal value"}</ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
