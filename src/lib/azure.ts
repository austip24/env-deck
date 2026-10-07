// Pure helpers for "Push to Azure App Service": where each key goes, what it replaces and what
// can't be pushed. No React, no IPC. The push itself runs `az` from Rust (azure.rs), which
// re-reads the values.

import type { Var } from "@/lib/env";
import type { AzureDest, AzureField, AzurePushItem, AzureSite, AzureState } from "@/lib/ipc";

export interface AzureRow {
  key: string;
  value: string;
  checked: boolean;
  dest: AzureDest;
  /** App setting or connection string name. */
  name: string;
  /** Catalog id when `dest` is "field". */
  fieldId: string | null;
  connType: string;
  /** Sticks to its slot (app settings and connection strings only). */
  slotSetting: boolean;
}

const CONN_KEY = /^ConnectionStrings__(.+)$/i;

/** Mirrors `azure::is_valid_setting_name`. */
export function isValidSettingName(name: string): boolean {
  return /^[A-Za-z0-9_.:-]{1,256}$/.test(name);
}

/** Linux apps only see letters, digits and _ as-is in environment variable names. */
export function linuxNameNote(name: string): string | null {
  if (/^[A-Za-z0-9_]+$/.test(name)) return null;
  return name.includes(":")
    ? "Linux apps can't read : in names; use __ for nested settings"
    : "Linux apps may not see this name as-is (use letters, digits and _)";
}

/**
 * One row per variable, as app settings. `ConnectionStrings__Name` keys (the .NET convention)
 * start as connection string `Name`. Checked: the table selection when there is one, else all.
 */
export function initialRows(vars: Var[], selected: ReadonlySet<string>): AzureRow[] {
  return vars.map((v) => {
    const conn = CONN_KEY.exec(v.key);
    const row: AzureRow = {
      key: v.key,
      value: v.value,
      checked: false,
      dest: conn ? "connectionString" : "appSetting",
      name: conn ? conn[1] : v.key,
      fieldId: null,
      connType: "Custom",
      slotSetting: false,
    };
    row.checked = (selected.size === 0 || selected.has(v.key)) && rowProblem(row, []) === null;
    return row;
  });
}

export function fieldOf(row: Pick<AzureRow, "dest" | "fieldId">, fields: AzureField[]): AzureField | undefined {
  return row.dest === "field" ? fields.find((f) => f.id === row.fieldId) : undefined;
}

/** Mirrors `azure::parse_value`: why a value doesn't fit a field, or null. */
export function fieldValueProblem(field: AzureField, raw: string): string | null {
  const v = raw.trim();
  if (v === "") return `${field.label} needs a value`;
  switch (field.kind) {
    case "path":
      return v.startsWith("/") ? null : `${field.label} must start with /`;
    case "bool":
      return /^(true|false|1|0|yes|no|on|off)$/i.test(v) ? null : `${field.label} must be true or false`;
    case "count":
      return /^\d+$/.test(v) && Number(v) >= 1 ? null : `${field.label} must be a whole number of at least 1`;
    case "choice":
      return field.choices.some((c) => c.toLowerCase() === v.toLowerCase())
        ? null
        : `${field.label} must be one of ${field.choices.join(", ")}`;
    default:
      return null;
  }
}

/** Why a row can't be pushed as set up, or null. */
export function rowProblem(row: AzureRow, fields: AzureField[]): string | null {
  if (row.dest === "field") {
    const field = fieldOf(row, fields);
    if (!field) return "Pick a setting";
    return fieldValueProblem(field, row.value);
  }
  if (!isValidSettingName(row.name)) return "Names allow letters, digits and _ . - : only";
  return null;
}

/** Where a row writes; mirrors `Write::slot_key` in azure.rs. */
export function targetOf(row: AzureRow, fields: AzureField[]): string | null {
  if (row.dest === "appSetting") return `app:${row.name.toLowerCase()}`;
  if (row.dest === "connectionString") return `conn:${row.name.toLowerCase()}`;
  return fieldOf(row, fields)?.target ?? null;
}

/** Checked rows that write the same place as an earlier checked row. */
export function duplicateKeys(rows: AzureRow[], fields: AzureField[]): Set<string> {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const row of rows) {
    if (!row.checked || rowProblem(row, fields) !== null) continue;
    const target = targetOf(row, fields);
    if (target === null) continue;
    if (seen.has(target)) dupes.add(row.key);
    else seen.add(target);
  }
  return dupes;
}

const has = (list: string[], name: string) => list.some((n) => n.toLowerCase() === name.toLowerCase());

/** Adds a name, overwrites one, or updates a setting that always exists. */
export function rowStatus(row: AzureRow, state: AzureState): "new" | "replaces" | "updates" {
  if (row.dest === "appSetting") return has(state.appSettings, row.name) ? "replaces" : "new";
  if (row.dest === "connectionString") return has(state.connectionStrings, row.name) ? "replaces" : "new";
  const field = fieldOf(row, state.fields);
  if (field?.appSetting) return has(state.appSettings, field.appSetting) ? "replaces" : "new";
  return "updates";
}

export function pushableRows(rows: AzureRow[], fields: AzureField[]): AzureRow[] {
  const dupes = duplicateKeys(rows, fields);
  return rows.filter((r) => r.checked && rowProblem(r, fields) === null && !dupes.has(r.key));
}

export function summarize(rows: AzureRow[], state: AzureState): { count: number; replace: number } {
  const ready = pushableRows(rows, state.fields);
  return { count: ready.length, replace: ready.filter((r) => rowStatus(r, state) === "replaces").length };
}

export function toAzureItems(rows: AzureRow[], fields: AzureField[]): AzurePushItem[] {
  return pushableRows(rows, fields).map((r) => ({
    key: r.key,
    dest: r.dest,
    name: r.dest === "field" ? null : r.name,
    field: r.dest === "field" ? r.fieldId : null,
    connType: r.dest === "connectionString" ? r.connType : null,
    slotSetting: r.dest !== "field" && r.slotSetting,
  }));
}

/** What saving the pushable rows does to the running app. */
export function pushEffects(rows: AzureRow[], fields: AzureField[]): { restarts: boolean; redeploys: boolean } {
  const ready = pushableRows(rows, fields);
  return {
    restarts: ready.length > 0,
    redeploys: ready.some((r) => fieldOf(r, fields)?.target.startsWith("src:")),
  };
}

/** The app `.azure/config` names, matched by name (and resource group when given). */
export function hintedSite(
  sites: AzureSite[],
  hint: { group: string | null; web: string | null } | null,
): AzureSite | undefined {
  if (!hint?.web) return undefined;
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  return sites.find((s) => eq(s.name, hint.web!) && (!hint.group || eq(s.resourceGroup, hint.group)));
}

/** "Web app (Linux)", "Function app", ... for an App Service `kind`. */
export function siteKindLabel(kind: string): string {
  const k = kind.toLowerCase();
  const base = k.includes("functionapp") ? "Function app" : k.includes("workflowapp") ? "Logic app" : "Web app";
  return k.includes("linux") ? `${base} (Linux)` : base;
}
