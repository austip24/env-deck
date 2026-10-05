// Mock IPC for `npm run dev:mock`: an in-memory file system behind the same commands as
// src-tauri/src/commands.rs, so the UI runs in a plain browser. Never imported by the app
// bundle (see main.tsx); scripts/check-bundle.mjs enforces that.
//
// The dotenv parsing lives in mock-dotenv.ts, a small mock-only port of envfile.rs.

import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import type {
  ConfigContent,
  ConfigFile,
  CopyOutcome,
  EnvVar,
  FolderView,
  GithubAccount,
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

const state = {
  savedRoots: ["~/code"],
  sessionRoots: [] as string[],
  library: "~/dev-configs" as string | null,
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

function setEnvVars(path: string, vars: EnvVar[]): number {
  ensureWithin(path, true);
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
  environments: ["production", "staging"],
  repoNames: { secrets: ["CMS_TOKEN"], variables: [] },
  envNames: { production: { secrets: [], variables: ["PREVIEW"] }, staging: { secrets: [], variables: [] } },
  warnings: [],
};

/** Mock sign-in (github_auth.rs): in memory, like the real token. */
const githubAuth = {
  login: null as string | null,
  pending: null as number | null,
  generation: 0,
  approveAfterMs: 2000,
};

const githubAccount = (): GithubAccount => ({ configured: true, login: githubAuth.login });

function requireSignIn() {
  if (!githubAuth.login) throw "GH_AUTH: Sign in to GitHub to continue.";
}

/** The mock EnvDeck GitHub App is installed on `acme/*` only, so the `fork` remote shows the install prompt. */
function requireInstalled(r: GithubRemote) {
  if (r.owner !== "acme") {
    throw `GH_NOT_INSTALLED: EnvDeck isn't installed on ${r.owner}/${r.name}. Install the EnvDeck GitHub App on it (or ask an owner to), then try again.`;
  }
}

function githubPush(path: string, remote: string, items: GithubPushItem[]): GithubPushResult[] {
  const r = githubRemote(path, remote);
  requireInstalled(r);
  const vars = new Map(effectiveVars(parseEnv(getFile(path).text)).map((v) => [v.key, v.value]));
  return items.map((item) => {
    const value = vars.get(item.key);
    let error: string | null = null;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.key) || /^GITHUB_/i.test(item.key)) {
      error = `"${item.key}" isn't a valid GitHub name`;
    } else if (value === undefined) error = `${item.key} isn't in the file any more`;
    else if (value === "") error = "GitHub doesn't accept empty values";
    else if (item.key === "FAIL_ME") error = "HTTP 403: Resource not accessible by integration";
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
  set_env_vars: (a) => setEnvVars(a.path as string, a.vars as EnvVar[]),
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
    requireSignIn();
    requireInstalled(r);
    return structuredClone({ ...github, repo: `${r.owner}/${r.name}` });
  },
  github_push: (a) => {
    requireSignIn();
    return githubPush(a.path as string, a.remote as string, a.items as GithubPushItem[]);
  },
  github_account: () => githubAccount(),
  github_sign_in_start: () => {
    githubAuth.generation += 1;
    githubAuth.pending = githubAuth.generation;
    console.info("[mock] open https://github.com/login/device (native only)");
    return { userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresIn: 900 };
  },
  github_sign_in_wait: async () => {
    const flow = githubAuth.pending;
    if (flow === null) throw "GH_AUTH: No sign-in in progress.";
    // Pretend the user approves the code on GitHub after a moment.
    await new Promise((r) => setTimeout(r, githubAuth.approveAfterMs));
    if (githubAuth.generation !== flow) throw "GH_AUTH: Sign-in cancelled.";
    githubAuth.pending = null;
    githubAuth.login = "octocat";
    return githubAccount();
  },
  github_open_verification: () => console.info("[mock] open https://github.com/login/device (native only)"),
  github_open_page: (a) => {
    const r = githubRemote(a.path as string, a.remote as string);
    const url =
      a.page === "install"
        ? "https://github.com/apps/envdeck/installations/new"
        : `https://github.com/${r.owner}/${r.name}/settings/environments`;
    console.info(`[mock] open ${url} (native only)`);
  },
  github_sign_out: () => {
    githubAuth.login = null;
    githubAuth.pending = null;
    githubAuth.generation += 1;
    return githubAccount();
  },
  start_drag: (a) => console.info("[mock] drag-out (native only):", ensureWithin(a.path as string)),

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
  /** Tests: how long the mock "user" takes to approve a GitHub sign-in. */
  githubApproveAfter: (ms: number) => {
    githubAuth.approveAfterMs = ms;
  },
  touch: (path: string, text: string) => {
    put(path, text);
    return emit("configs-changed", { paths: [path] });
  },
  remove: (path: string) => {
    files.delete(path);
    return emit("configs-changed", { paths: [path] });
  },
};

console.info(`[${MOCK_SENTINEL}] mock IPC active`);
