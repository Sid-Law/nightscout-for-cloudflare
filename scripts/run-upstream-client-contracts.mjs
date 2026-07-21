import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const upstreamRoot = join(repositoryRoot, "vendor", "nightscout");
const upstreamBundle = join(
  upstreamRoot,
  "node_modules",
  ".cache",
  "_ns_cache",
  "public",
  "js",
  "bundle.app.js",
);
const deployedAsset = join(repositoryRoot, "public", "bundle", "js", "bundle.app.js");

const upstreamBytes = readFileSync(upstreamBundle);
const deployedBytes = readFileSync(deployedAsset);
if (!upstreamBytes.equals(deployedBytes)) {
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  throw new Error(
    `Official client bundle mismatch: upstream=${digest(upstreamBytes)} public=${digest(deployedBytes)}`,
  );
}

const envCommand = join(upstreamRoot, "node_modules", ".bin", "env-cmd");
const mochaCommand = join(upstreamRoot, "node_modules", ".bin", "mocha");
const result = spawnSync(
  envCommand,
  [
    "-f",
    "./tests/ci.test.env",
    mochaCommand,
    "--timeout",
    "5000",
    "--require",
    "./tests/hooks.js",
    "--exit",
    "./tests/pluginbase.test.js",
    "./tests/client.renderer.test.js",
    "./tests/errorcodes.test.js",
    "./tests/utils.test.js",
    "./tests/careportal.test.js",
    "./tests/boluswizardpreview.test.js",
    "./tests/profileeditor.test.js",
  ],
  {
    cwd: upstreamRoot,
    env: process.env,
    stdio: "inherit",
  },
);

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

console.log(
  "Seven locked client/bundled-module files passed 30 tests unchanged against the byte-identical NSCF client bundle.",
);
