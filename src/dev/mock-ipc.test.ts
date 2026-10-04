// Drives the typed wrappers in lib/ipc.ts against the dev:mock backend, so argument names and
// result shapes stay in step between the two.
import { beforeAll, describe, expect, it } from "vitest";
import { errorCode, ipc } from "@/lib/ipc";

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
    const template = files.find((f) => f.kind === "env-template")!;
    await expect(ipc.createFromTemplate(template.path)).rejects.toSatisfy((e) => errorCode(e) === "EXISTS");
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
