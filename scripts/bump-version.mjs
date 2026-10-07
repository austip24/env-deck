// Sets EnvDeck's version everywhere it is declared, ahead of tagging a release:
//   npm run release:version -- 0.2.0
// The updater compares this version with latest.json, so all of them must agree. Every file is
// checked before any is written, so a failure leaves them all untouched.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const version = process.argv[2]?.replace(/^v/, "");
if (!version || !SEMVER.test(version)) {
  console.error("usage: npm run release:version -- <major.minor.patch>");
  process.exit(1);
}

const file = (rel) => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const read = (rel) => readFileSync(file(rel), "utf8");

function fail(message) {
  console.error(`bump-version: ${message}; no files were changed`);
  process.exit(1);
}

/** Replaces exactly one match of `re` (no `g` flag) in `rel`. */
function replaceOnce(rel, re, to) {
  const text = read(rel);
  const count = text.match(new RegExp(re.source, re.flags + "g"))?.length ?? 0;
  if (count !== 1) fail(`expected one version in ${rel}, found ${count}`);
  return [rel, text.replace(re, to)];
}

/** Rewrites a JSON file, keeping its indentation (tabs or spaces) and line endings. */
function editJson(rel, edit) {
  const text = read(rel);
  const json = JSON.parse(text);
  edit(json);
  const indent = /^\{\r?\n([ \t]+)/.exec(text)?.[1] ?? "  ";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  return [rel, (JSON.stringify(json, null, indent) + "\n").replace(/\n/g, eol)];
}

const edits = [
  editJson("package.json", (j) => (j.version = version)),
  editJson("package-lock.json", (j) => {
    j.version = version;
    if (j.packages?.[""]) j.packages[""].version = version;
  }),
  // The app's version as Tauri and the updater see it. Edited as text to keep its formatting;
  // the top-level "version" is the first one in the file.
  replaceOnce("src-tauri/tauri.conf.json", /^([ \t]*"version"\s*:\s*)"[^"]*"/m, `$1"${version}"`),
  replaceOnce("src-tauri/Cargo.toml", /^(version = )"[^"]*"/m, `$1"${version}"`),
  replaceOnce("src-tauri/Cargo.lock", /(name = "env-deck"\r?\nversion = )"[^"]*"/, `$1"${version}"`),
];
for (const [rel, text] of edits) writeFileSync(file(rel), text);

console.log(`bump-version: ${version}. Commit, then tag v${version} and push the tag.`);
