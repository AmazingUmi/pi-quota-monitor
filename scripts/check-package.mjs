import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const fail = (message) => { throw new Error(`Invalid Pi package: ${message}`); };

if (!manifest.keywords?.includes("pi-package")) fail("missing pi-package keyword");
if (!Array.isArray(manifest.pi?.extensions) || manifest.pi.extensions.length !== 1) {
  fail("declare the single extension entry in pi.extensions");
}
for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"]) {
  if (manifest.peerDependencies?.[name] !== "*") fail(`${name} must be a * peer dependency`);
}

const [packed] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
  cwd: root,
  encoding: "utf8",
}));
const files = new Set(packed.files.map(({ path }) => path));
for (const entry of manifest.pi.extensions) {
  if (typeof entry !== "string" || !/^\.\/extensions\/[^*?!]+\.tsx?$/.test(entry)) {
    fail(`expected a concrete extensions/ entry, got ${entry}`);
  }
  if (!files.has(entry.slice(2))) fail(`${entry} is missing from the npm tarball`);
}
for (const asset of [
  "src/index.ts",
  "src/dashboard/index.html",
  "src/dashboard/client.js",
  "src/dashboard/style.css",
  "src/dashboard/favicon.svg",
]) {
  if (!files.has(asset)) fail(`${asset} is missing from the npm tarball`);
}
console.log(`Pi package OK: ${packed.name}@${packed.version} (${files.size} files)`);
