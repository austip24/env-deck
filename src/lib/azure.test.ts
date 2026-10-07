import { describe, expect, it } from "vitest";
import {
  duplicateKeys,
  fieldValueProblem,
  hintedSite,
  initialRows,
  isValidSettingName,
  linuxNameNote,
  pushEffects,
  rowProblem,
  rowStatus,
  siteKindLabel,
  summarize,
  toAzureItems,
  type AzureRow,
} from "./azure";
import type { AzureField, AzureSite, AzureState } from "./ipc";

const field = (id: string, over: Partial<AzureField> = {}): AzureField => ({
  id,
  label: id,
  section: "general",
  kind: "text",
  choices: [],
  secret: false,
  appSetting: null,
  target: `web:${id}`,
  note: null,
  ...over,
});

const fields: AzureField[] = [
  field("startupCommand", { target: "web:appCommandLine" }),
  field("runtimeStack", { target: "web:linuxFxVersion" }),
  field("containerImage", { section: "deployment", target: "web:linuxFxVersion" }),
  field("alwaysOn", { kind: "bool" }),
  field("minTlsVersion", { kind: "choice", choices: ["1.2", "1.3"] }),
  field("healthCheckPath", { kind: "path" }),
  field("numberOfWorkers", { kind: "count" }),
  field("registryPassword", {
    section: "deployment",
    secret: true,
    appSetting: "DOCKER_REGISTRY_SERVER_PASSWORD",
    target: "app:docker_registry_server_password",
  }),
  field("branch", { section: "deployment", target: "src:branch", note: "Changing the source starts a deployment" }),
];

const state: AzureState = {
  site: "shop-api",
  slot: null,
  linux: true,
  appSettings: ["API_KEY", "DOCKER_REGISTRY_SERVER_PASSWORD"],
  connectionStrings: ["Main"],
  stickyAppSettings: [],
  stickyConnectionStrings: [],
  fields,
  connectionTypes: ["Custom", "SQLAzure"],
  warnings: [],
};

const vars = [
  { key: "API_KEY", value: "sk_1" },
  { key: "ConnectionStrings__Main", value: "Server=x" },
  { key: "EMPTY", value: "" },
  { key: "bad name", value: "x" },
  { key: "START", value: "node server.js" },
];

const row = (over: Partial<AzureRow>): AzureRow => ({
  key: "K",
  value: "v",
  checked: true,
  dest: "appSetting",
  name: "K",
  fieldId: null,
  connType: "Custom",
  slotSetting: false,
  ...over,
});

describe("names", () => {
  it("follows App Service naming rules", () => {
    for (const ok of ["API_KEY", "Logging:LogLevel", "app.name", "a-b"]) expect(isValidSettingName(ok)).toBe(true);
    for (const bad of ["", "A B", "A=B", "a/b"]) expect(isValidSettingName(bad)).toBe(false);
  });

  it("warns about names Linux apps won't see as-is", () => {
    expect(linuxNameNote("API_KEY")).toBeNull();
    expect(linuxNameNote("Logging:LogLevel")).toMatch(/__/);
    expect(linuxNameNote("app.name")).toMatch(/Linux/);
  });
});

describe("rows", () => {
  it("starts as app settings, with ConnectionStrings__X as connection string X", () => {
    const rows = initialRows(vars, new Set());
    expect(rows.map((r) => [r.dest, r.name, r.checked])).toEqual([
      ["appSetting", "API_KEY", true],
      ["connectionString", "Main", true],
      ["appSetting", "EMPTY", true], // Azure accepts empty values
      ["appSetting", "bad name", false],
      ["appSetting", "START", true],
    ]);
  });

  it("checks only the table selection when there is one", () => {
    const rows = initialRows(vars, new Set(["START"]));
    expect(rows.filter((r) => r.checked).map((r) => r.key)).toEqual(["START"]);
  });

  it("checks field values like Rust does", () => {
    const f = (id: string) => fields.find((x) => x.id === id)!;
    expect(fieldValueProblem(f("alwaysOn"), "Yes")).toBeNull();
    expect(fieldValueProblem(f("alwaysOn"), "maybe")).toMatch(/true or false/);
    expect(fieldValueProblem(f("minTlsVersion"), "1.2")).toBeNull();
    expect(fieldValueProblem(f("minTlsVersion"), "2.0")).toMatch(/one of 1.2, 1.3/);
    expect(fieldValueProblem(f("healthCheckPath"), "healthz")).toMatch(/start with \//);
    expect(fieldValueProblem(f("numberOfWorkers"), "0")).toMatch(/at least 1/);
    expect(fieldValueProblem(f("startupCommand"), " ")).toMatch(/needs a value/);
    expect(rowProblem(row({ dest: "field", fieldId: null }), fields)).toBe("Pick a setting");
  });

  it("flags rows that write the same place", () => {
    const rows = [
      row({ key: "A", dest: "field", fieldId: "runtimeStack" }),
      row({ key: "B", dest: "field", fieldId: "containerImage" }),
      row({ key: "C", name: "docker_registry_server_password" }),
      row({ key: "D", dest: "field", fieldId: "registryPassword" }),
      row({ key: "E", dest: "field", fieldId: "containerImage", checked: false }),
    ];
    expect([...duplicateKeys(rows, fields)]).toEqual(["B", "D"]);
    expect(summarize(rows, state).count).toBe(2);
  });

  it("works out what each row replaces", () => {
    expect(rowStatus(row({ name: "api_key" }), state)).toBe("replaces");
    expect(rowStatus(row({ name: "NEW" }), state)).toBe("new");
    expect(rowStatus(row({ dest: "connectionString", name: "Main" }), state)).toBe("replaces");
    expect(rowStatus(row({ dest: "field", fieldId: "registryPassword" }), state)).toBe("replaces");
    expect(rowStatus(row({ dest: "field", fieldId: "alwaysOn" }), state)).toBe("updates");
  });

  it("builds push items and says what saving does", () => {
    const rows = [
      row({ key: "API_KEY", name: "API_KEY", slotSetting: true }),
      row({ key: "DB", dest: "connectionString", name: "Main", connType: "SQLAzure" }),
      row({ key: "BR", dest: "field", fieldId: "branch", slotSetting: true }),
      row({ key: "OFF", checked: false }),
    ];
    expect(toAzureItems(rows, fields)).toEqual([
      { key: "API_KEY", dest: "appSetting", name: "API_KEY", field: null, connType: null, slotSetting: true },
      { key: "DB", dest: "connectionString", name: "Main", field: null, connType: "SQLAzure", slotSetting: false },
      { key: "BR", dest: "field", name: null, field: "branch", connType: null, slotSetting: false },
    ]);
    expect(pushEffects(rows, fields)).toEqual({ restarts: true, redeploys: true });
    expect(pushEffects(rows.slice(0, 2), fields)).toEqual({ restarts: true, redeploys: false });
    expect(pushEffects([], fields)).toEqual({ restarts: false, redeploys: false });
  });
});

describe("sites", () => {
  const site = (name: string, resourceGroup: string, kind = "app,linux"): AzureSite => ({
    id: `/subscriptions/x/resourceGroups/${resourceGroup}/providers/Microsoft.Web/sites/${name}`,
    name,
    resourceGroup,
    kind,
    location: "westeurope",
  });

  it("finds the app .azure/config names", () => {
    const sites = [site("shop-api", "other-rg"), site("shop-api", "shop-rg"), site("web", "shop-rg")];
    expect(hintedSite(sites, { group: "SHOP-RG", web: "Shop-Api" })).toBe(sites[1]);
    expect(hintedSite(sites, { group: null, web: "web" })).toBe(sites[2]);
    expect(hintedSite(sites, { group: null, web: "nope" })).toBeUndefined();
    expect(hintedSite(sites, null)).toBeUndefined();
  });

  it("labels app kinds", () => {
    expect(siteKindLabel("app,linux")).toBe("Web app (Linux)");
    expect(siteKindLabel("functionapp")).toBe("Function app");
    expect(siteKindLabel("app")).toBe("Web app");
  });
});
