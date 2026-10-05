// Automated part of the native smoke test (Windows only: drives WebView2 over CDP).
//
//   node scripts/native-smoke.mjs
//
// Builds a throwaway sandbox (config + sample projects) in the OS temp folder, starts
// `npm run tauri dev` with ENVDECK_CONFIG pointing at it (your ~/.envdeck.json is never touched),
// runs scope, write, watcher, CSP and permission checks against the real app, then stops it.
// Things that need eyes and hands (drag-out, file clipboard, reveal, editor links, dialogs) are
// in docs/SMOKE_TEST.md.

import { spawn, execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.platform !== "win32") {
  console.error("native-smoke: Windows only (uses WebView2 remote debugging). See docs/SMOKE_TEST.md.");
  process.exit(2);
}

const PORT = 9223;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- sandbox ----------------------------------------------------------------------------------
const sandbox = mkdtempSync(join(tmpdir(), "envdeck-smoke-"));
const code = join(sandbox, "code");
const put = (rel, text) => {
  const p = join(sandbox, ...rel.split("/"));
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
  return p;
};
put("code/shop/.git/HEAD", "ref\n");
put("code/shop/apps/api/package.json", "{}");
const apiEnv = put("code/shop/apps/api/.env", "# api\r\nPORT=4000\r\nDB_PASSWORD=hunter2\r\n");
put("code/shop/apps/api/.env.example", "PORT=\nDB_PASSWORD=\nNEW_KEY=\n");
put("code/shop/apps/web/node_modules/pkg/.env", "X=1\n");
const webEnv = put("code/shop/apps/web/.env", "A=1\n");
const outside = put("outside/secret.env", "S=1\n");
mkdirSync(join(sandbox, "dest"));
const config = join(sandbox, "envdeck.json");
writeFileSync(config, JSON.stringify({ roots: [code] }, null, 2));

// --- app --------------------------------------------------------------------------------------
console.log(`native-smoke: sandbox ${sandbox}`);
const app = spawn("npm", ["run", "tauri", "dev"], {
  shell: true,
  env: {
    ...process.env,
    ENVDECK_CONFIG: config,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
  },
  stdio: "ignore",
});
const stop = () => {
  try {
    execSync(`taskkill /pid ${app.pid} /T /F`, { stdio: "ignore" });
  } catch {}
};

let failed = 0;
try {
  let target;
  for (let i = 0; i < 600 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      target = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
    } catch {}
    if (!target) await sleep(500);
  }
  if (!target) throw new Error("EnvDeck's webview never appeared (is port 1420 or 9223 in use?)");

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id;
      pending.set(i, r);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const evaluate = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description;
  };
  const call = (cmd, args = {}) =>
    evaluate(
      `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)}).then(v => ({ok: true, value: v}), e => ({ok: false, error: String(e)}))`,
    );
  const check = (name, pass, detail = "") => {
    if (!pass) failed++;
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}${!pass && detail ? `\n      ${detail}` : ""}`);
  };

  await sleep(1500);

  const manifest = await call("get_manifest");
  check("reads ENVDECK_CONFIG", manifest.ok && manifest.value.roots.length === 1, JSON.stringify(manifest));

  const scan = await call("scan");
  const names = scan.value?.files.map((f) => `${f.projectName}:${f.relPath}`) ?? [];
  check("scan finds configs and skips node_modules", names.includes("api:.env") && !names.some((n) => n.includes("node_modules")), names.join(", "));

  const read = await call("read_config", { path: apiEnv });
  check("reads a CRLF dotenv", read.ok && read.value.lineEnding === "crlf" && read.value.env.lines.length === 3, JSON.stringify(read));

  for (const [label, path] of [
    ["outside the roots", outside],
    ["a ..-escape", join(code, "..", "outside", "secret.env")],
    ["a system file", "C:\\Windows\\win.ini"],
  ]) {
    const r = await call("read_config", { path });
    check(`refuses to read ${label}`, !r.ok && /outside/.test(r.error), JSON.stringify(r));
  }

  const stale = await call("write_config", { path: apiEnv, content: "X=1\r\n", expectedModifiedMs: read.value.modifiedMs - 1 });
  check("refuses a stale save", !stale.ok && stale.error.startsWith("STALE"), JSON.stringify(stale));

  const badKey = await call("set_env_vars", { path: apiEnv, vars: [{ key: "NEW KEY", value: "x" }] });
  check("rejects an invalid variable name", !badKey.ok, JSON.stringify(badKey));
  const upsert = await call("set_env_vars", { path: apiEnv, vars: [{ key: "PORT", value: "5000" }, { key: "ADDED", value: "a b" }] });
  const onDisk = readFileSync(apiEnv, "utf8");
  check(
    "upsert keeps CRLF and comments on disk",
    upsert.ok && onDisk === "# api\r\nPORT=5000\r\nDB_PASSWORD=hunter2\r\nADDED='a b'\r\n",
    JSON.stringify(onDisk),
  );

  const webDir = join(code, "shop", "apps", "web");
  const ungranted = await call("copy_config", { src: apiEnv, destDir: join(sandbox, "dest"), onConflict: "fail", fileName: null });
  check("refuses to copy to an ungranted folder", !ungranted.ok && /outside/.test(ungranted.error), JSON.stringify(ungranted));
  const exists = await call("copy_config", { src: apiEnv, destDir: webDir, onConflict: "fail", fileName: null });
  check("copy 'fail' policy refuses to overwrite", !exists.ok && exists.error.startsWith("EXISTS"), JSON.stringify(exists));
  const backup = await call("copy_config", { src: apiEnv, destDir: webDir, onConflict: "backup", fileName: null });
  check("copy 'backup' policy keeps the old file", backup.ok && backup.value.action === "backedUp" && !!backup.value.backupPath, JSON.stringify(backup));
  const badName = await call("copy_config", { src: apiEnv, destDir: webDir, onConflict: "fail", fileName: "..\\evil.env" });
  check("rejects a path as a file name", !badName.ok, JSON.stringify(badName));
  const tmpl = await call("create_from_template", { path: join(code, "shop", "apps", "api", ".env.example") });
  check("create-from-template never overwrites", !tmpl.ok && tmpl.error.startsWith("EXISTS"), JSON.stringify(tmpl));

  const roots = await call("save_manifest", { settings: { roots: ["C:\\"] } });
  check("save_manifest refuses roots from the page", !roots.ok, JSON.stringify(roots));
  check("config file unchanged", JSON.parse(readFileSync(config, "utf8")).roots.length === 1);

  const fsPlugin = await call("plugin:fs|read_text_file", { path: "C:\\Windows\\win.ini" });
  check("fs plugin isn't reachable", !fsPlugin.ok, JSON.stringify(fsPlugin));
  const url = await call("plugin:opener|open_url", { url: "https://example.com" });
  check("opener refuses non-editor URLs", !url.ok, JSON.stringify(url));
  const win = await call("plugin:window|set_title", { label: "main", value: "x" });
  check("window commands aren't granted", !win.ok, JSON.stringify(win));
  for (const cmd of ["reveal", "start_drag"]) {
    const r = await call(cmd, { path: "C:\\Windows\\win.ini" });
    check(`${cmd} refuses out-of-scope paths`, !r.ok && /outside/.test(r.error), JSON.stringify(r));
  }
  const clip = await call("copy_files_to_clipboard", { paths: ["C:\\Windows\\win.ini"] });
  check("file clipboard refuses out-of-scope paths", !clip.ok && /outside/.test(clip.error), JSON.stringify(clip));

  const net = await evaluate(`fetch("https://example.com").then(() => "fetched", e => "blocked: " + e.message)`);
  check("CSP blocks network requests from the page", String(net).startsWith("blocked"), String(net));

  await evaluate(
    `(() => { window.__got = []; const h = window.__TAURI_INTERNALS__.transformCallback(e => window.__got.push(e.payload.paths)); return window.__TAURI_INTERNALS__.invoke('plugin:event|listen', {event: 'configs-changed', target: {kind: 'Any'}, handler: h}).then(() => true) })()`,
  );
  await sleep(300);
  writeFileSync(webEnv, "A=2\n");
  writeFileSync(join(sandbox, "code", "shop", "apps", "web", "node_modules", "pkg", ".env"), "X=2\n");
  await sleep(2000);
  const got = String(await evaluate(`JSON.stringify(window.__got)`));
  check("watcher reports an external edit", got.includes("web\\\\.env"), got);
  check("watcher ignores node_modules", !got.includes("node_modules"), got);

  await evaluate(`window.__marker = 42`);
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers: 2, key: "r", code: "KeyR", windowsVirtualKeyCode: 82 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 2, key: "r", code: "KeyR", windowsVirtualKeyCode: 82 });
  await sleep(1200);
  check("Ctrl+R rescans instead of reloading the page", (await evaluate(`window.__marker`)) === 42);

  ws.close();
} catch (e) {
  failed++;
  console.error(`native-smoke: ${e.message}`);
} finally {
  stop();
  await sleep(500);
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {}
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
