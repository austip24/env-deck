// Drives the typed wrappers in lib/ipc.ts against the dev:mock backend, so argument names and
// result shapes stay in step between the two.
import { beforeAll, describe, expect, it } from "vitest";
import { errorCode, errorText, ipc, onConfigsChanged, onUpdateProgress, type UpdateProgress } from "@/lib/ipc";

beforeAll(async () => {
  // mockIPC installs itself on `window`; give Node one.
  (globalThis as { window?: unknown }).window ??= globalThis;
  await import("./mock-ipc");
});

describe("mock IPC through lib/ipc.ts", () => {
  it("scans the sample tree", async () => {
    const manifest = await ipc.getManifest();
    expect(manifest.roots[0]).toMatchObject({ display: "~/code", saved: true });
    const result = await ipc.scan();
    const rel = result.files.map((f) => `${f.projectName}:${f.relPath}`);
    expect(rel).toContain("web:.env.example");
    expect(rel).toContain("api:appsettings.Development.json");
    expect(rel.some((r) => r.includes("node_modules"))).toBe(false);
    expect(result.roots.find((r) => r.library)?.display).toBe("~/dev-configs");
  });

  it("reads, saves with a stale check and upserts", async () => {
    const { files } = await ipc.scan();
    const api = files.find((f) => f.projectName === "api" && f.name === ".env")!;
    const content = await ipc.readConfig(api.path);
    expect(content.lineEnding).toBe("crlf");
    expect(content.env?.lines.some((l) => l.type === "other")).toBe(true);

    await expect(ipc.writeConfig(api.path, "X=1\r\n", content.modifiedMs - 1)).rejects.toSatisfy(
      (e) => errorCode(e) === "STALE",
    );
    await ipc.setEnvVars(api.path, [{ key: "PORT", value: "5000" }]);
    expect((await ipc.readConfig(api.path)).text).toContain("PORT=5000\r\n");

    // A value edited in the table carries the mtime it was loaded with.
    const loaded = await ipc.readConfig(api.path);
    await expect(
      ipc.setEnvVars(api.path, [{ key: "PORT", value: "6000" }], loaded.modifiedMs - 1),
    ).rejects.toSatisfy((e) => errorCode(e) === "STALE");
    await ipc.setEnvVars(api.path, [{ key: "PORT", value: "6000" }], loaded.modifiedMs);
    expect((await ipc.readConfig(api.path)).text).toContain("PORT=6000\r\n");
  });

  it("copies with conflict policies and refuses out-of-scope paths", async () => {
    const { files } = await ipc.scan();
    const web = files.find((f) => f.projectName === "web" && f.name === ".env")!;
    const apiDir = files.find((f) => f.projectName === "api")!.project;
    await expect(ipc.copyConfig(web.path, apiDir)).rejects.toSatisfy((e) => errorCode(e) === "EXISTS");
    const out = await ipc.copyConfig(web.path, apiDir, "keepBoth");
    expect(out).toMatchObject({ action: "keptBoth" });
    expect(out.path.endsWith("/.env.copy")).toBe(true);

    await expect(ipc.readConfig("/etc/passwd")).rejects.toMatch(/outside/);
    const dest = await ipc.pickDestination();
    expect((await ipc.copyConfig(web.path, dest!)).action).toBe("created");
  });

  it("never overwrites when creating from a template", async () => {
    const { files } = await ipc.scan();
    const withTarget = files.find((f) => f.kind === "env-template" && f.projectName === "web")!;
    await expect(ipc.createFromTemplate(withTarget.path)).rejects.toSatisfy((e) => errorCode(e) === "EXISTS");
    const withoutTarget = files.find((f) => f.name === ".env.production.example")!;
    const created = await ipc.createFromTemplate(withoutTarget.path);
    expect(created.endsWith("/blog/.env.production")).toBe(true);
    expect((await ipc.readConfig(created)).text).toContain("ANALYTICS_ID=");
  });

  it("handles the plugin and native calls the UI makes", async () => {
    await expect(ipc.writeClipboardText("A=1\n")).resolves.toBeUndefined();
    await expect(ipc.openEditorUrl("vscode://file/Users/dev/code/.env")).resolves.toBeUndefined();
    const { files } = await ipc.scan();
    await expect(ipc.copyFilesToClipboard([files[0].path])).resolves.toBeUndefined();
    await expect(ipc.reveal("/etc/hosts")).rejects.toMatch(/outside/);
  });

  it("delivers simulated watcher events through onConfigsChanged", async () => {
    const got: string[][] = [];
    const unlisten = await onConfigsChanged((paths) => got.push(paths));
    const mock = (globalThis as unknown as { __envdeckMock: { touch: (p: string, t: string) => Promise<void> } })
      .__envdeckMock;
    const path = "/Users/dev/code/blog/.env.local";
    await mock.touch(path, "CMS_TOKEN=changed\n");
    unlisten();
    expect(got).toEqual([[path]]);
    expect((await ipc.readConfig(path)).text).toBe("CMS_TOKEN=changed\n");
  });

  it("detects the GitHub repo beside a dotenv file and pushes per key", async () => {
    const path = "/Users/dev/code/blog/.env.local";
    const repo = await ipc.githubRepo(path);
    expect(repo.remotes.map((r) => `${r.remote}:${r.owner}/${r.name}`)).toEqual(["origin:acme/blog", "fork:dev/blog"]);
    await expect(ipc.githubRepo("/Users/dev/code/shop/apps/web/.env")).rejects.toSatisfy(
      (e) => errorCode(e) === "NO_REPO",
    );

    // gh isn't signed in for the fork's owner: inspect and push say how to sign in.
    const ghAuth = (e: unknown) => errorCode(e) === "GH_AUTH" && errorText(e).includes("gh auth login");
    await expect(ipc.githubInspect(path, "fork")).rejects.toSatisfy(ghAuth);
    await expect(
      ipc.githubPush(path, "fork", [{ key: "CMS_TOKEN", kind: "secret", environment: null }]),
    ).rejects.toSatisfy(ghAuth);

    // No EnvDeck sign-in: gh's own login is used as is.
    const state = await ipc.githubInspect(path, "origin");
    expect(state.repo).toBe("acme/blog");
    expect(state.login).toBe("octocat");
    const results = await ipc.githubPush(path, "origin", [
      { key: "CMS_TOKEN", kind: "variable", environment: "staging" },
      { key: "CMS_TOKEN", kind: "secret", environment: "preview" },
      { key: "MISSING", kind: "secret", environment: null },
    ]);
    expect(results.map((r) => r.error === null)).toEqual([true, false, false]);
    expect(results[1].error).toMatch(/doesn't exist/);
    const after = await ipc.githubInspect(path, "origin");
    expect(after.environments).not.toContain("preview");
    expect(after.envNames.staging.variables).toEqual(["CMS_TOKEN"]);
  });

  it("pushes to an Azure App Service the Azure CLI listed", async () => {
    const path = "/Users/dev/code/shop/apps/api/.env";
    expect(await ipc.azureHint(path)).toEqual({ group: "shop-rg", web: "shop-api" });
    expect(await ipc.azureHint("/Users/dev/code/blog/.env.local")).toBeNull();

    const account = await ipc.azureAccount();
    expect(account.user).toBe("dev@contoso.com");
    const sub = account.subscriptions[0];
    expect(sub.isDefault).toBe(true);

    // Only apps that were listed can be targeted.
    const unlisted = "/subscriptions/7c9e6679-7425-40de-944b-e07fc1f90ae7/resourceGroups/shop-prod-rg/providers/Microsoft.Web/sites/shop-api-prod";
    await expect(ipc.azureInspect(unlisted, null)).rejects.toMatch(/Pick the app again/);

    const sites = await ipc.azureListApps(sub.id);
    const api = sites.find((s) => s.name === "shop-api")!;
    expect(await ipc.azureListSlots(api.id)).toEqual(["staging"]);
    const before = await ipc.azureInspect(api.id, "staging");
    expect(before.linux).toBe(true);
    expect(before.fields.some((f) => f.id === "containerImage")).toBe(true);

    const results = await ipc.azurePush(path, api.id, "staging", [
      { key: "STRIPE_SECRET_KEY", dest: "appSetting", name: null, field: null, connType: null, slotSetting: true },
      { key: "DATABASE_URL", dest: "connectionString", name: null, field: null, connType: "PostgreSQL", slotSetting: false },
      { key: "PORT", dest: "field", name: null, field: "alwaysOn", connType: null, slotSetting: false },
      { key: "MISSING", dest: "appSetting", name: null, field: null, connType: null, slotSetting: false },
    ]);
    expect(results.map((r) => r.error === null)).toEqual([true, true, false, false]);
    expect(results[2].error).toMatch(/true or false/);
    const after = await ipc.azureInspect(api.id, "staging");
    expect(after.appSettings).toContain("STRIPE_SECRET_KEY");
    expect(after.connectionStrings).toEqual(["DATABASE_URL"]);
    expect(after.stickyAppSettings).toEqual(["STRIPE_SECRET_KEY"]);
    await expect(ipc.azureOpenPortal(api.id, "staging", "deploymentCenter")).resolves.toBeUndefined();

    // az signed out: every call says how to sign in.
    const mock = (globalThis as unknown as { __envdeckMock: { azureSignedIn: (v: boolean) => void } }).__envdeckMock;
    mock.azureSignedIn(false);
    const azAuth = (e: unknown) => errorCode(e) === "AZ_AUTH" && errorText(e).includes("az login");
    await expect(ipc.azureAccount()).rejects.toSatisfy(azAuth);
    await expect(ipc.azureInspect(api.id, null)).rejects.toSatisfy(azAuth);
    mock.azureSignedIn(true);
  });

  it("checks for and installs an update", async () => {
    const mock = (globalThis as unknown as { __envdeckMock: { updateAvailable: (v: boolean) => void } }).__envdeckMock;
    mock.updateAvailable(false);
    expect(await ipc.checkUpdate()).toBeNull();
    await expect(ipc.installUpdate()).rejects.toSatisfy((e) => errorCode(e) === "NO_UPDATE");

    mock.updateAvailable(true);
    expect(await ipc.checkUpdate()).toMatchObject({ version: "0.2.0", currentVersion: "0.1.0" });
    const seen: UpdateProgress[] = [];
    const unlisten = await onUpdateProgress((p) => seen.push(p));
    await ipc.installUpdate();
    unlisten();
    expect(seen.at(-1)).toEqual({ downloaded: 12_582_912, total: 12_582_912 });
  });

  it("adds a session folder", async () => {
    await ipc.removeFolder("/Users/dev/code");
    await ipc.addFolder(false);
    const { files, roots } = await ipc.scan();
    expect(roots.some((r) => !r.saved && r.display === "~/scratch/demo")).toBe(true);
    const demo = files.find((f) => f.root.endsWith("/scratch/demo"))!;
    expect(demo.name).toBe(".env");
  });
});
