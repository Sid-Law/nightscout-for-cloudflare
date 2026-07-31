#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  shouldAutoUpdate,
  syncOfficialSource,
} from "./sync-cloudflare-source.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

function run(command, args) {
  execFileSync(command, args, {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit",
    timeout: 20 * 60_000,
  });
}

if (shouldAutoUpdate({ projectRoot })) {
  console.log(
    "Cloudflare source-import deployment detected; checking the official update channel.",
  );
  const upstreamSha = syncOfficialSource({
    projectRoot,
    upstreamUrl:
      process.env.NSCF_UPSTREAM_URL ??
      "https://github.com/sid-luo/nightscout-for-cloudflare.git",
    upstreamBranch: process.env.NSCF_UPSTREAM_BRANCH ?? "main",
  });
  console.log(`Using official source ${upstreamSha}.`);
  run("npm", ["ci", "--no-audit", "--no-fund"]);
} else {
  console.log(
    "Building the checked-out source. Automatic source refresh is only enabled for Cloudflare-imported deployment copies.",
  );
}

run("npm", ["run", "build:source"]);
