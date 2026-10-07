// Mock IPC for `npm run dev:mock`: an in-memory file system behind the same commands as
// src-tauri/src/commands.rs, so the UI runs in a plain browser. Never imported by the app
// bundle (see main.tsx); scripts/check-bundle.mjs enforces that.
//
// The dotenv parsing lives in mock-dotenv.ts, a small mock-only port of envfile.rs.

import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import type {
  AzureAccount,
  AzureField,
  AzurePushItem,
  AzurePushResult,
  AzureSite,
  AzureState,
  ConfigContent,
  ConfigFile,
  CopyOutcome,
  EnvVar,
  FolderView,
  GithubPushItem,
  GithubPushResult,
  GithubRemote,
  GithubState,
  ManifestView,
  OnConflict,
  RootStatus,
  ScanResult,
  Settings,
  SettingsUpdate,
  UpdateInfo,
} from "@/lib/ipc";
import {
  detectEnding,
  isDotenvName,
  KEY_RE,
  kindOf,
  parseEnv,
  templateTarget,
  upsert,
} from "@/dev/mock-dotenv";
import { fieldValueProblem, isValidSettingName } from "@/lib/azure";
import { effectiveVars } from "@/lib/env";

// Sentinel checked by scripts/check-bundle.mjs; do not remove.
export const MOCK_SENTINEL = "__ENVDECK_MOCK_IPC__";

const HOME = "/Users/dev";

// --- fake file system -------------------------------------------------------------------------

interface MockFile {
  text: string;
  modifiedMs: number;
}

const files = new Map<string, MockFile>();
let clock = Date.now() - 86_400_000;

function put(path: string, text: string) {
  clock += 60_000;
  files.set(path, { text, modifiedMs: clock });
}

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dirname = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
const join = (dir: string, name: string) => `${dir.replace(/\/$/, "")}/${name}`;
const expand = (p: string) => (p === "~" ? HOME : p.startsWith("~/") ? HOME + p.slice(1) : p);
const contract = (p: string) => (p === HOME ? "~" : p.startsWith(HOME + "/") ? "~" + p.slice(HOME.length) : p);
const inside = (p: string, root: string) => p === root || p.startsWith(root.replace(/\/$/, "") + "/");
const dirExists = (dir: string) => [...files.keys()].some((f) => inside(f, dir) && f !== dir);

function seed() {
  const shop = `${HOME}/code/shop`;
  put(`${shop}/.git/HEAD`, "ref: refs/heads/main\n");
  put(`${shop}/package.json`, "{}\n");
  put(`${shop}/docker-compose.yml`, "services:\n  db:\n    image: postgres:16\n    env_file: apps/api/.env\n");
  put(`${shop}/.vscode/launch.json`, '{\n  "version": "0.2.0",\n  "configurations": []\n}\n');

  put(`${shop}/apps/web/package.json`, "{}\n");
  put(
    `${shop}/apps/web/.env`,
    [
      "# Web app",
      "NEXT_PUBLIC_API_URL=http://localhost:4000",
      "NEXT_PUBLIC_STRIPE_KEY=pk_test_FAKE0000000000000000",
      "SESSION_SECRET='not-a-real-secret $with dollars'",
      "export NODE_ENV=development",
      "",
    ].join("\n"),
  );
  put(
    `${shop}/apps/web/.env.example`,
    [
      "# Copy to .env and fill in",
      "NEXT_PUBLIC_API_URL=http://localhost:4000",
      "NEXT_PUBLIC_STRIPE_KEY=",
      "SESSION_SECRET=",
      "NODE_ENV=development",
      "SENTRY_DSN= # added after the last onboarding",
      "",
    ].join("\n"),
  );

  put(`${shop}/apps/api/package.json`, "{}\n");
  // Written by `az webapp up`: preselects the app in "Push to Azure".
  put(`${shop}/apps/api/.azure/config`, "[defaults]\ngroup = shop-rg\nweb = shop-api\nsku = B1\n");
  put(
    `${shop}/apps/api/.env`,
    [
      "# API (CRLF line endings)",
      "PORT=4000",
      "DATABASE_URL=postgres://shop:hunter2@localhost:5432/shop",
      "STRIPE_SECRET_KEY=sk_test_FAKE0000000000000000",
      'JWT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----',
      "MIIBVAIBADANBgkqhkiG9w0BAQEFAASCAT4wggE6AgEAAkEAFAKEFAKEFAKE",
      '-----END PRIVATE KEY-----"',
      "LOG_LEVEL=debug # verbose locally",
      "this line is not valid",
      "",
    ].join("\r\n"),
  );
  put(
    `${shop}/apps/api/appsettings.Development.json`,
    '{\n  "ConnectionStrings": {\n    "Default": "Server=localhost;Database=shop;User Id=sa;Password=FakePassw0rd!"\n  }\n}\n',
  );

  const blog = `${HOME}/code/blog`;
  put(`${blog}/package.json`, "{}\n");
  // A GitHub remote beside .env.local, for "Push to GitHub".
  put(
    `${blog}/.git/config`,
    '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:acme/blog.git\n[remote "fork"]\n\turl = https://github.com/dev/blog\n',
  );
  put(`${blog}/.env.local`, "CMS_TOKEN=fake-token-123\nPREVIEW=true\n");
  // A template whose target (.env.production) doesn't exist yet.
  put(`${blog}/.env.production.example`, "CMS_TOKEN=\nPREVIEW=false\nANALYTICS_ID=\n");
  put(`${blog}/.npmrc`, "//registry.npmjs.org/:_authToken=${NPM_TOKEN}\nsave-exact=true\n");
  put(`${blog}/node_modules/some-pkg/.env`, "IGNORED=yes\n");

  put(`${HOME}/dev-configs/payments/.env.stripe`, "STRIPE_SECRET_KEY=sk_test_FAKE_LIBRARY\nSTRIPE_WEBHOOK_SECRET=whsec_FAKE\n");
  put(`${HOME}/dev-configs/.npmrc`, "@acme:registry=https://npm.acme.test/\n");

  // Picked by the fake folder dialogs.
  put(`${HOME}/scratch/demo/.env`, "DEMO=1\n");
}
seed();

// --- session state (mirrors state.rs) ---------------------------------------------------------

const DEFAULT_SETTINGS: Settings = {
  include: [
    ".env",
    ".env.*",
    "*.env",
    ".npmrc",
    ".yarnrc.yml",
    "appsettings*.json",
    "application*.yml",
    "application*.yaml",
    "application*.properties",
    "docker-compose*.yml",
    "docker-compose*.yaml",
    "compose*.yaml",
    ".vscode/launch.json",
    ".vscode/settings.json",
  ],
  excludeDirs: [
    "node_modules", ".git", "target", "dist", "build", "bin", "obj", ".next", ".nuxt",
    ".venv", "venv", "__pycache__", ".gradle", ".idea", "AppData", "Library",
  ],
  maxDepth: 8,
  maxFileBytes: 524_288,
  editor: "vscode",
};

// `?fresh` starts with an empty manifest, like a first run (shows the tutorial).
const fresh = typeof location !== "undefined" && new URLSearchParams(location.search).has("fresh");

const state = {
  savedRoots: fresh ? [] : ["~/code"],
  sessionRoots: [] as string[],
  library: (fresh ? null : "~/dev-configs") as string | null,
  settings: { ...DEFAULT_SETTINGS },
  grants: [] as string[],
};

const PICKED_FOLDER = `${HOME}/scratch/demo`;
const PICKED_DESTINATION = `${HOME}/Desktop`;

function manifestView(): ManifestView {
  const folder = (path: string, saved: boolean): FolderView => ({ path, display: contract(path), saved });
  return {
    configPath: `${HOME}/.envdeck.json`,
    configDisplay: "~/.envdeck.json",
    home: HOME,
    roots: [
      ...state.savedRoots.map((r) => folder(expand(r), true)),
      ...state.sessionRoots.map((r) => folder(r, false)),
    ],
    library: state.library ? folder(expand(state.library), true) : null,
    settings: state.settings,
    warnings: [],
    error: null,
  };
}

function readScopes(): string[] {
  return [
    ...state.savedRoots.map(expand),
    ...state.sessionRoots,
    ...(state.library ? [expand(state.library)] : []),
  ];
}

function ensureWithin(path: string, write = false): string {
  const scopes = write ? [...readScopes(), ...state.grants] : readScopes();
  if (path.split("/").includes("..") || !scopes.some((s) => inside(path, s))) {
    throw `${path} is outside the scanned folders and library`;
  }
  return path;
}

function getFile(path: string): MockFile {
  const f = files.get(path);
  if (!f) throw `${path} doesn't exist`;
  return f;
}

// --- scan (mirrors scan.rs) -------------------------------------------------------------------

const MARKERS = [".git", "package.json", "Cargo.toml", "go.mod", "pyproject.toml", "global.json"];

function globToRegex(pattern: string): RegExp {
  const rooted = pattern.startsWith("/");
  const body = (rooted ? pattern.slice(1) : pattern.replace(/^\*\*\//, ""))
    .split("")
    .map((c) => (c === "*" ? "[^/]*" : c === "?" ? "[^/]" : c.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${rooted ? "" : "(?:.*/)?"}${body}$`, "i");
}

function projectOf(path: string, root: string): string {
  for (let dir = dirname(path); inside(dir, root); dir = dirname(dir)) {
    if (MARKERS.some((m) => dirExists(join(dir, m)) || files.has(join(dir, m)))) return dir;
    if (dir === root) break;
  }
  return dirname(path);
}

function scan(): ScanResult {
  const started = performance.now();
  const globs = state.settings.include.map(globToRegex);
  const excluded = new Set(state.settings.excludeDirs);
  const specs = [
    ...state.savedRoots.map((r) => ({ path: expand(r), saved: true, library: false })),
    ...state.sessionRoots.map((r) => ({ path: r, saved: false, library: false })),
    ...(state.library ? [{ path: expand(state.library), saved: true, library: true }] : []),
  ];
  const seen = new Set<string>();
  const out: ConfigFile[] = [];
  const roots: RootStatus[] = [];
  // Most specific root first, as in scan.rs.
  const order = [...specs.keys()].sort((a, b) => specs[b].path.length - specs[a].path.length);
  const statuses = new Map<number, RootStatus>();
  for (const i of order) {
    const spec = specs[i];
    const status: RootStatus = {
      path: spec.path,
      display: contract(spec.path),
      saved: spec.saved,
      library: spec.library,
      status: dirExists(spec.path) ? "ok" : "missing",
      message: dirExists(spec.path) ? null : "Folder not found",
      fileCount: 0,
      skipped: 0,
      truncated: false,
    };
    statuses.set(i, status);
    for (const [path, f] of files) {
      if (!inside(path, spec.path) || seen.has(path)) continue;
      const rel = path.slice(spec.path.length + 1);
      const parts = rel.split("/");
      if (parts.length > state.settings.maxDepth) continue;
      if (parts.slice(0, -1).some((p) => excluded.has(p))) continue;
      if (!globs.some((g) => g.test(rel))) continue;
      seen.add(path);
      const project = projectOf(path, spec.path);
      out.push({
        path,
        root: spec.path,
        project,
        projectName: basename(project),
        projectRelPath: project === spec.path ? "" : project.slice(spec.path.length + 1),
        relPath: path.slice(project.length + 1),
        name: basename(path),
        kind: kindOf(basename(path)),
        size: new TextEncoder().encode(f.text).length,
        modifiedMs: f.modifiedMs,
      });
      status.fileCount++;
    }
  }
  specs.forEach((_, i) => roots.push(statuses.get(i)!));
  const rank = new Map(specs.map((s, i) => [s.path, i]));
  out.sort(
    (a, b) =>
      rank.get(a.root)! - rank.get(b.root)! ||
      a.projectRelPath.localeCompare(b.projectRelPath) ||
      a.relPath.localeCompare(b.relPath),
  );
  return { files: out, roots, truncated: false, warnings: [], elapsedMs: Math.round(performance.now() - started) };
}

// --- commands ---------------------------------------------------------------------------------

function readConfig(path: string): ConfigContent {
  ensureWithin(path);
  const f = getFile(path);
  const name = basename(path);
  return {
    path,
    name,
    kind: kindOf(name),
    text: f.text,
    lineEnding: detectEnding(f.text),
    hasBom: false,
    modifiedMs: f.modifiedMs,
    size: new TextEncoder().encode(f.text).length,
    env: isDotenvName(name) ? parseEnv(f.text) : null,
  };
}

function setEnvVars(path: string, vars: EnvVar[], expectedModifiedMs: number | null = null): number {
  ensureWithin(path, true);
  if (expectedModifiedMs !== null && getFile(path).modifiedMs !== expectedModifiedMs) {
    throw `STALE: ${path} changed on disk since it was loaded. Reload it first.`;
  }
  const bad = vars.find((v) => !KEY_RE.test(v.key));
  if (bad) throw `"${bad.key}" isn't a valid variable name`;
  if (!isDotenvName(basename(path))) throw `${path} isn't a dotenv file`;
  put(path, upsert(getFile(path).text, vars));
  return getFile(path).modifiedMs;
}

function unusedName(dir: string, base: string): string {
  let candidate = join(dir, base);
  for (let n = 2; files.has(candidate); n++) candidate = join(dir, `${base}-${n}`);
  return candidate;
}

function copyConfig(src: string, destDir: string, onConflict: OnConflict = "fail", fileName: string | null): CopyOutcome {
  ensureWithin(src);
  ensureWithin(destDir, true);
  const name = fileName ?? basename(src);
  if (!name || name === "." || name === ".." || /[/\\:*?"<>|]/.test(name)) throw `"${name}" isn't a valid file name`;
  const text = getFile(src).text;
  const dest = join(destDir, name);
  if (!files.has(dest)) { put(dest, text); return { path: dest, action: "created", backupPath: null }; }
  switch (onConflict) {
    case "fail":
      throw `EXISTS: ${dest} already exists`;
    case "overwrite":
      put(dest, text);
      return { path: dest, action: "overwritten", backupPath: null };
    case "backup": {
      const backup = unusedName(destDir, `${name}.bak-${Math.floor(Date.now() / 1000)}`);
      put(backup, getFile(dest).text);
      put(dest, text);
      return { path: dest, action: "backedUp", backupPath: backup };
    }
    case "keepBoth": {
      const target = unusedName(destDir, `${name}.copy`);
      put(target, text);
      return { path: target, action: "keptBoth", backupPath: null };
    }
    case "merge": {
      if (!isDotenvName(basename(src))) throw `${src} isn't a dotenv file`;
      const vars: EnvVar[] = [];
      for (const l of parseEnv(text).lines) if (l.type === "pair") vars.push({ key: l.key, value: l.value });
      setEnvVars(dest, vars);
      return { path: dest, action: "merged", backupPath: null };
    }
  }
}

// --- GitHub (mirrors github.rs; nothing leaves the browser) -----------------------------------

const REMOTE_RE = /\[remote "([^"]+)"\]\s*\n\s*url = (?:git@|https:\/\/)([^:/\s]+)[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\s*$/gm;

function githubRemotes(path: string): GithubRemote[] {
  ensureWithin(path);
  if (!isDotenvName(basename(path))) throw `${path} isn't a dotenv file`;
  const config = files.get(join(dirname(path), ".git/config"));
  if (!config) throw `NO_REPO: ${dirname(path)} has no .git folder`;
  const remotes: GithubRemote[] = [...config.text.matchAll(REMOTE_RE)].map((m) => ({
    remote: m[1],
    host: m[2],
    owner: m[3],
    name: m[4],
  }));
  if (remotes.length === 0) throw "NO_REPO: The repository next to this file has no GitHub remote";
  return remotes.sort((a, b) => Number(b.remote === "origin") - Number(a.remote === "origin"));
}

function githubRemote(path: string, remote: string): GithubRemote {
  const r = githubRemotes(path).find((x) => x.remote === remote);
  if (!r) throw `NO_REPO: No GitHub remote named ${remote}`;
  return r;
}

const github: GithubState = {
  repo: "",
  login: "octocat",
  environments: ["production", "staging"],
  repoNames: { secrets: ["CMS_TOKEN"], variables: [] },
  envNames: { production: { secrets: [], variables: ["PREVIEW"] }, staging: { secrets: [], variables: [] } },
  warnings: [],
};

/**
 * Mock `gh auth login`: signed in for `acme/*` only, so the `fork` remote shows the
 * "GitHub CLI isn't signed in" screen.
 */
function requireGhLogin(r: GithubRemote) {
  if (r.owner !== "acme") {
    throw "GH_AUTH: The GitHub CLI isn't signed in to GitHub. Run gh auth login in a terminal, then try again.";
  }
}

function githubPush(path: string, remote: string, items: GithubPushItem[]): GithubPushResult[] {
  const r = githubRemote(path, remote);
  requireGhLogin(r);
  const vars = new Map(effectiveVars(parseEnv(getFile(path).text)).map((v) => [v.key, v.value]));
  return items.map((item) => {
    const value = vars.get(item.key);
    let error: string | null = null;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.key) || /^GITHUB_/i.test(item.key)) {
      error = `"${item.key}" isn't a valid GitHub name`;
    } else if (value === undefined) error = `${item.key} isn't in the file any more`;
    else if (value === "") error = "GitHub doesn't accept empty values";
    else if (item.key === "FAIL_ME") error = "GitHub refused: you need write access to the repository (admin for some lists), and gh's token needs the repo scope (gh auth refresh -s repo). (HTTP 403: Resource not accessible by personal access token)";
    else if (item.environment !== null && !github.environments.includes(item.environment)) {
      error = `The ${item.environment} environment doesn't exist on GitHub. Create it in the repository's settings first.`;
    } else {
      const names = item.environment === null ? github.repoNames : github.envNames[item.environment];
      const list = item.kind === "secret" ? names.secrets : names.variables;
      if (!list.includes(item.key)) list.push(item.key);
    }
    // Key names only; never values.
    const env = item.environment ? ` --env ${item.environment}` : "";
    console.info(`[mock] gh ${item.kind} set ${item.key} --repo ${r.owner}/${r.name}${env}`);
    return { ...item, error };
  });
}

// --- Azure App Service (mirrors azure.rs; nothing leaves the browser) --------------------------

const DEV_SUB = "0b1f6471-1bf0-4dda-aec3-111122223333";
const PROD_SUB = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

const siteOf = (sub: string, rg: string, name: string, kind: string): AzureSite => ({
  id: `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Web/sites/${name}`,
  name,
  resourceGroup: rg,
  kind,
  location: "westeurope",
});

const azureSites: Record<string, AzureSite[]> = {
  [DEV_SUB]: [
    siteOf(DEV_SUB, "shop-rg", "shop-api", "app,linux"),
    siteOf(DEV_SUB, "shop-rg", "shop-web", "app"),
    siteOf(DEV_SUB, "jobs-rg", "shop-jobs", "functionapp,linux"),
  ],
  [PROD_SUB]: [siteOf(PROD_SUB, "shop-prod-rg", "shop-api-prod", "app,linux")],
};
const azureSlots: Record<string, string[]> = { "shop-api": ["staging"], "shop-api-prod": ["staging", "canary"] };

/** Existing names per app or slot (`id` or `id/slots/x`), and slot settings per app. */
type NameSets = { app: Set<string>; conn: Set<string> };
const azureNames = new Map<string, NameSets>();
const azureSticky = new Map<string, NameSets>();
function namesFor(map: Map<string, NameSets>, key: string): NameSets {
  if (!map.has(key)) map.set(key, { app: new Set(), conn: new Set() });
  return map.get(key)!;
}
namesFor(azureNames, azureSites[DEV_SUB][0].id).app.add("PORT");
namesFor(azureNames, azureSites[DEV_SUB][0].id).conn.add("DATABASE_URL");

const listedSites = new Set<string>();
let azureSignedIn = true;

const AZ_AUTH =
  "AZ_AUTH: The Azure CLI isn't signed in, or its sign-in expired. Run az login in a terminal, then try again.";
const REDEPLOYS = "Changing the source starts a deployment";

function mockField(
  id: string,
  label: string,
  section: AzureField["section"],
  kind: AzureField["kind"],
  target: string,
  extra: Partial<AzureField> = {},
): AzureField {
  return { id, label, section, kind, choices: [], secret: false, appSetting: null, target, note: null, ...extra };
}

/** Mirrors `azure::FIELDS`. */
const AZURE_FIELDS: AzureField[] = [
  mockField("startupCommand", "Startup command", "general", "text", "web:appCommandLine"),
  mockField("runtimeStack", "Runtime stack (Linux, e.g. NODE|20-lts)", "general", "text", "web:linuxFxVersion"),
  mockField("alwaysOn", "Always on", "general", "bool", "web:alwaysOn"),
  mockField("http20Enabled", "HTTP 2.0", "general", "bool", "web:http20Enabled"),
  mockField("webSocketsEnabled", "Web sockets", "general", "bool", "web:webSocketsEnabled"),
  mockField("use32BitWorkerProcess", "32-bit worker process", "general", "bool", "web:use32BitWorkerProcess"),
  mockField("minTlsVersion", "Minimum TLS version", "general", "choice", "web:minTlsVersion", {
    choices: ["1.0", "1.1", "1.2", "1.3"],
  }),
  mockField("ftpsState", "FTP state", "general", "choice", "web:ftpsState", {
    choices: ["AllAllowed", "FtpsOnly", "Disabled"],
  }),
  mockField("healthCheckPath", "Health check path", "general", "path", "web:healthCheckPath"),
  mockField("numberOfWorkers", "Number of workers", "general", "count", "web:numberOfWorkers"),
  mockField("containerImage", "Container image (Linux)", "deployment", "text", "web:linuxFxVersion"),
  mockField("registryUrl", "Registry server URL", "deployment", "text", "app:docker_registry_server_url", {
    appSetting: "DOCKER_REGISTRY_SERVER_URL",
  }),
  mockField("registryUsername", "Registry username", "deployment", "text", "app:docker_registry_server_username", {
    appSetting: "DOCKER_REGISTRY_SERVER_USERNAME",
  }),
  mockField("registryPassword", "Registry password", "deployment", "text", "app:docker_registry_server_password", {
    appSetting: "DOCKER_REGISTRY_SERVER_PASSWORD",
    secret: true,
  }),
  mockField("repoUrl", "Source repository URL", "deployment", "text", "src:repoUrl", { note: REDEPLOYS }),
  mockField("branch", "Source branch", "deployment", "text", "src:branch", { note: REDEPLOYS }),
];
const CONNECTION_TYPES = [
  "Custom",
  "SQLAzure",
  "SQLServer",
  "MySql",
  "PostgreSQL",
  "RedisCache",
  "DocDb",
  "EventHub",
  "ServiceBus",
  "NotificationHub",
  "ApiHub",
];

function requireAzLogin() {
  if (!azureSignedIn) throw AZ_AUTH;
}

/** Mirrors `commands::azure_site`: only apps listed this session. */
function azureSite(siteId: string, slot: string | null = null): AzureSite {
  requireAzLogin();
  const site = Object.values(azureSites)
    .flat()
    .find((s) => s.id.toLowerCase() === siteId.toLowerCase());
  if (!site || !listedSites.has(site.id)) throw "Pick the app again: EnvDeck only uses apps the Azure CLI listed";
  if (slot !== null && !/^[A-Za-z0-9-]{1,59}$/.test(slot)) throw `"${slot}" isn't a deployment slot name`;
  return site;
}

const slotKey = (site: AzureSite, slot: string | null) => (slot ? `${site.id}/slots/${slot}` : site.id);

function azureInspect(siteId: string, slot: string | null): AzureState {
  const site = azureSite(siteId, slot);
  const names = namesFor(azureNames, slotKey(site, slot));
  const sticky = namesFor(azureSticky, site.id);
  return structuredClone({
    site: site.name,
    slot,
    linux: site.kind.includes("linux"),
    appSettings: [...names.app].sort(),
    connectionStrings: [...names.conn].sort(),
    stickyAppSettings: [...sticky.app],
    stickyConnectionStrings: [...sticky.conn],
    fields: AZURE_FIELDS,
    connectionTypes: CONNECTION_TYPES,
    warnings: [],
  });
}

function azurePush(path: string, siteId: string, slot: string | null, items: AzurePushItem[]): AzurePushResult[] {
  ensureWithin(path);
  if (!isDotenvName(basename(path))) throw `${path} isn't a dotenv file`;
  const site = azureSite(siteId, slot);
  const vars = new Map(effectiveVars(parseEnv(getFile(path).text)).map((v) => [v.key, v.value]));
  const names = namesFor(azureNames, slotKey(site, slot));
  const sticky = namesFor(azureSticky, site.id);
  const taken = new Set<string>();
  return items.map((item) => {
    const value = vars.get(item.key);
    const name = item.name ?? item.key;
    const field = AZURE_FIELDS.find((f) => f.id === item.field);
    let error: string | null = null;
    let target = "";
    if (value === undefined) error = `${item.key} isn't in the file any more`;
    else if (item.dest === "field") {
      error = field ? fieldValueProblem(field, value) : `"${item.field}" isn't a setting EnvDeck can set`;
      target = field?.target ?? "";
      if (!error && field?.id === "containerImage" && !site.kind.includes("linux")) {
        error = "Container images can only be set here for Linux apps";
      }
    } else if (!isValidSettingName(name)) error = `"${name}" isn't a valid name (letters, digits, _ . - :)`;
    else if (item.dest === "connectionString" && !CONNECTION_TYPES.includes(item.connType ?? "Custom")) {
      error = `"${item.connType}" isn't a connection string type`;
    } else target = `${item.dest === "appSetting" ? "app" : "conn"}:${name.toLowerCase()}`;
    if (!error && taken.has(target)) error = "Another row already sets this";
    if (!error && item.key === "FAIL_ME") {
      error =
        "Azure refused: your account needs write access to the app (for example the Website Contributor role). ((AuthorizationFailed))";
    }
    if (!error) {
      taken.add(target);
      if (item.dest === "appSetting") names.app.add(name);
      if (item.dest === "connectionString") names.conn.add(name);
      if (field?.appSetting) names.app.add(field.appSetting);
      if (item.slotSetting && item.dest !== "field") (item.dest === "appSetting" ? sticky.app : sticky.conn).add(name);
    }
    // Key names only; never values.
    console.info(`[mock] az rest: ${item.dest} ${item.field ?? name} on ${site.name}${slot ? `/${slot}` : ""}`);
    return { key: item.key, error };
  });
}

function azureHint(path: string) {
  ensureWithin(path);
  if (!isDotenvName(basename(path))) throw `${path} isn't a dotenv file`;
  const config = files.get(join(dirname(path), ".azure/config"))?.text ?? "";
  const value = (k: string) =>
    config
      .split("\n")
      .map((l) => l.split("="))
      .find(([key]) => key.trim() === k)?.[1]
      ?.trim() || null;
  return value("web") ? { group: value("group"), web: value("web") } : null;
}

// --- updates (update.rs) ----------------------------------------------------------------------

const MOCK_UPDATE: UpdateInfo = {
  version: "0.2.0",
  currentVersion: "0.1.0",
  notes: "- Faster scans of large folders\n- Push to Azure App Service slots",
  date: "2026-10-01T09:00:00Z",
};
/** Whether the next check finds MOCK_UPDATE; `__envdeckMock.updateAvailable(false)` says "up to date". */
let updateAvailable = true;
let checkedUpdate: UpdateInfo | null = null;

async function installUpdate() {
  if (!checkedUpdate) throw "NO_UPDATE: Check for updates first";
  const total = 12_582_912;
  for (let downloaded = 0; downloaded <= total; downloaded += total / 8) {
    await emit("update-progress", { downloaded, total });
    await new Promise((r) => setTimeout(r, 150));
  }
  console.info(`[mock] install ${checkedUpdate.version} and restart (native only)`);
}

type Args = Record<string, unknown>;

const handlers: Record<string, (a: Args) => unknown> = {
  get_manifest: () => manifestView(),
  reload_manifest: () => manifestView(),
  save_manifest: (a) => {
    const update = a.settings as SettingsUpdate;
    state.settings = { ...state.settings, ...update };
    return manifestView();
  },
  add_folder: (a) => {
    if (a.persist) {
      const c = contract(PICKED_FOLDER);
      if (!state.savedRoots.includes(c)) state.savedRoots.push(c);
      state.sessionRoots = state.sessionRoots.filter((r) => r !== PICKED_FOLDER);
    } else if (!state.sessionRoots.includes(PICKED_FOLDER)) {
      state.sessionRoots.push(PICKED_FOLDER);
    }
    return PICKED_FOLDER;
  },
  save_folder: (a) => {
    const path = a.path as string;
    if (!state.sessionRoots.includes(path)) throw `${path} is outside the scanned folders and library`;
    state.sessionRoots = state.sessionRoots.filter((r) => r !== path);
    state.savedRoots.push(contract(path));
  },
  remove_folder: (a) => {
    const path = a.path as string;
    state.savedRoots = state.savedRoots.filter((r) => expand(r) !== path);
    state.sessionRoots = state.sessionRoots.filter((r) => r !== path);
    if (state.library && expand(state.library) === path) state.library = null;
  },
  set_library: () => {
    state.library = "~/dev-configs";
    return expand(state.library);
  },
  scan: () => scan(),
  read_config: (a) => readConfig(a.path as string),
  write_config: (a) => {
    const path = ensureWithin(a.path as string, true);
    const f = getFile(path);
    if (f.modifiedMs !== a.expectedModifiedMs) throw `STALE: ${path} changed on disk since it was loaded. Reload it first.`;
    put(path, a.content as string);
    return getFile(path).modifiedMs;
  },
  set_env_vars: (a) =>
    setEnvVars(a.path as string, a.vars as EnvVar[], (a.expectedModifiedMs as number | null) ?? null),
  pick_destination: () => {
    if (!state.grants.includes(PICKED_DESTINATION)) state.grants.push(PICKED_DESTINATION);
    return PICKED_DESTINATION;
  },
  copy_config: (a) =>
    copyConfig(a.src as string, a.destDir as string, (a.onConflict as OnConflict) ?? "fail", (a.fileName as string) ?? null),
  create_from_template: (a) => {
    const path = a.path as string;
    const target = templateTarget(basename(path));
    if (!target) throw `${basename(path)} isn't a dotenv template`;
    return copyConfig(path, dirname(path), "fail", target).path;
  },
  copy_files_to_clipboard: (a) => {
    (a.paths as string[]).forEach((p) => ensureWithin(p));
    console.info("[mock] file clipboard (native only):", a.paths);
  },
  reveal: (a) => console.info("[mock] reveal (native only):", ensureWithin(a.path as string)),
  github_repo: (a) => ({ remotes: githubRemotes(a.path as string) }),
  github_inspect: (a) => {
    const r = githubRemote(a.path as string, a.remote as string);
    requireGhLogin(r);
    return structuredClone({ ...github, repo: `${r.owner}/${r.name}` });
  },
  github_push: (a) => githubPush(a.path as string, a.remote as string, a.items as GithubPushItem[]),
  github_open_page: (a) => {
    const r = githubRemote(a.path as string, a.remote as string);
    if (a.page !== "environments") throw `Unknown GitHub page "${String(a.page)}"`;
    console.info(`[mock] open https://github.com/${r.owner}/${r.name}/settings/environments (native only)`);
  },
  start_drag: (a) => console.info("[mock] drag-out (native only):", ensureWithin(a.path as string)),
  azure_hint: (a) => azureHint(a.path as string),
  azure_account: (): AzureAccount => {
    requireAzLogin();
    return {
      user: "dev@contoso.com",
      subscriptions: [
        { id: DEV_SUB, name: "Contoso Dev", isDefault: true },
        { id: PROD_SUB, name: "Contoso Production", isDefault: false },
      ],
    };
  },
  azure_list_apps: (a) => {
    requireAzLogin();
    const sites = azureSites[a.subscription as string];
    if (!sites) throw `"${String(a.subscription)}" isn't a subscription id`;
    sites.forEach((s) => listedSites.add(s.id));
    return structuredClone(sites);
  },
  azure_list_slots: (a) => [...(azureSlots[azureSite(a.siteId as string).name] ?? [])],
  azure_inspect: (a) => azureInspect(a.siteId as string, (a.slot as string | null) ?? null),
  azure_push: (a) =>
    azurePush(a.path as string, a.siteId as string, (a.slot as string | null) ?? null, a.items as AzurePushItem[]),
  azure_open_portal: (a) => {
    const slot = (a.slot as string | null) ?? null;
    const site = azureSite(a.siteId as string, slot);
    const blades: Record<string, string> = {
      environment: "environmentVariablesAppSettings",
      configuration: "configuration",
      deploymentCenter: "vstscd",
    };
    const blade = blades[a.page as string];
    if (!blade) throw `Unknown Azure portal page "${String(a.page)}"`;
    console.info(`[mock] open https://portal.azure.com/#resource${slotKey(site, slot)}/${blade} (native only)`);
  },

  check_update: () => {
    checkedUpdate = updateAvailable ? structuredClone(MOCK_UPDATE) : null;
    return checkedUpdate;
  },
  install_update: () => installUpdate(),

  // Plugin commands the UI calls directly.
  "plugin:clipboard-manager|write_text": (a) => {
    const text = (a.text ?? a.data) as string;
    void navigator.clipboard?.writeText(text).catch(() => {});
  },
  "plugin:opener|open_url": (a) => console.info("[mock] open url (native only):", a.url),
};

mockIPC(
  (cmd, payload) => {
    const handler = handlers[cmd];
    if (!handler) throw `mock-ipc: no handler for "${cmd}"`;
    return handler((payload ?? {}) as Args);
  },
  { shouldMockEvents: true },
);

// Simulate an edit by another program (the watcher in watch.rs) from the devtools console:
//   __envdeckMock.touch("/Users/dev/code/shop/apps/web/.env", "A=1\n")
(window as unknown as { __envdeckMock: unknown }).__envdeckMock = {
  touch: (path: string, text: string) => {
    put(path, text);
    return emit("configs-changed", { paths: [path] });
  },
  remove: (path: string) => {
    files.delete(path);
    return emit("configs-changed", { paths: [path] });
  },
  /** Simulate `az login` / `az logout`:  __envdeckMock.azureSignedIn(false) */
  azureSignedIn: (signedIn: boolean) => {
    azureSignedIn = signedIn;
  },
  /** Whether the next update check finds 0.2.0:  __envdeckMock.updateAvailable(false) */
  updateAvailable: (available: boolean) => {
    updateAvailable = available;
  },
};

console.info(`[${MOCK_SENTINEL}] mock IPC active`);
