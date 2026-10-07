// Sets EnvDeck's version everywhere it is declared, ahead of tagging a release:
//   npm run release:version -- 0.2.0
// The updater compares this version with latest.json, so all of them must agree.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const version = process.argv[2]?.replace(/^v/, "");
if (!version || !SEMVER.test(version)) {
  console.error("usage: npm run release:version -- <major.minor.patch>");
  process.exit(1);
}

const file = (rel) => fileURLToPath(new URL(`../${rel}`, import.meta.url));

/** Replaces exactly one match of `re` in `rel`; fails loudly otherwise. */
function replaceOnce(rel, re, to) {
  const text = readFileSync(file(rel), "utf8");
  const matches = text.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"));
  if (matches?.length !== 1) {
    console.error(`bump-version: expected one version in ${rel}, found ${matches?.length ?? 0}`);
    process.exit(1);
  }
  writeFileSync(file(rel), text.replace(re, to));
}

/** Rewrites a JSON file, keeping 2-space indentation and its line endings. */
function setJsonVersion(rel, edit) {
  const text = readFileSync(file(rel), "utf8");
  const json = JSON.parse(text);
  edit(json);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  writeFileSync(file(rel), (JSON.stringify(json, null, 2) + "\n").replace(/\n/g, eol));
}

setJsonVersion("package.json", (j) => (j.version = version));
setJsonVersion("package-lock.json", (j) => {
  j.version = version;
  if (j.packages?.[""]) j.packages[""].version = version;
});
// tauri.conf.json is edited as text to keep its formatting.
replaceOnce("src-tauri/tauri.conf.json", /^(  "version": )"[^"]*"/m, `$1"${version}"`);
replaceOnce("src-tauri/Cargo.toml", /^(version = )"[^"]*"/m, `$1"${version}"`);
replaceOnce("src-tauri/Cargo.lock", /(name = "env-deck"\r?\nversion = )"[^"]*"/, `$1"${version}"`);

console.log(`bump-version: ${version}. Commit, then tag v${version} and push the tag.`);
