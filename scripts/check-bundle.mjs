// Fails the build if the dev-only mock IPC made it into dist/ (AGENTS.md: it must never ship).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SENTINEL = "__ENVDECK_MOCK_IPC__";
const dist = fileURLToPath(new URL("../dist", import.meta.url));

const leaks = readdirSync(dist, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => join(entry.parentPath, entry.name))
  .filter((path) => readFileSync(path, "latin1").includes(SENTINEL));

if (leaks.length > 0) {
  console.error(`check-bundle: mock IPC found in the app bundle:\n  ${leaks.join("\n  ")}`);
  process.exit(1);
}
console.log("check-bundle: ok (no mock IPC in dist)");
