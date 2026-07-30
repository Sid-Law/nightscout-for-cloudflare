import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const updateScript = path.join(scriptDir, "update-from-upstream.sh");
const workflow = readFileSync(
  path.join(
    projectRoot,
    ".github",
    "workflows",
    "update-nightscout-for-cloudflare.yml",
  ),
  "utf8",
);

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    stdio: options.stdio ?? "pipe",
  }).trim();
}

function git(cwd, ...args) {
  return run("git", args, { cwd });
}

function configureRepository(cwd) {
  git(cwd, "config", "user.name", "Updater Test");
  git(cwd, "config", "user.email", "updater-test@example.invalid");
}

function commitAll(cwd, message) {
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", message);
}

function parseOutputs(file) {
  return Object.fromEntries(
    readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function runUpdater(cwd, mode, root, extraEnv = {}) {
  const output = path.join(root, `${mode}-${Date.now()}-output.txt`);
  const summary = path.join(root, `${mode}-${Date.now()}-summary.md`);
  writeFileSync(output, "");
  writeFileSync(summary, "");

  const result = spawnSync("bash", [updateScript, mode], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
      NSCF_DEFAULT_BRANCH: "main",
      ...extraEnv,
    },
  });

  return {
    ...result,
    outputs: parseOutputs(output),
    summary: readFileSync(summary, "utf8"),
  };
}

test("manual update workflow uses separate read and write jobs", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /name: Check and validate update/);
  assert.match(workflow, /permissions:\n\s+contents: read/);
  assert.match(workflow, /name: Apply validated update/);
  assert.match(workflow, /permissions:\n\s+contents: write/);
  assert.match(
    workflow,
    /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/,
  );
  assert.match(
    workflow,
    /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/,
  );
  assert.doesNotMatch(workflow, /wrangler deploy|API_SECRET|CLOUDFLARE_API_TOKEN/);
});

test("updater applies a validated merge and leaves conflicts untouched", () => {
  const root = mkdtempSync(path.join(tmpdir(), "nscf-updater-test-"));

  try {
    const upstream = path.join(root, "upstream");
    const userOrigin = path.join(root, "user-origin.git");
    const deployedCopy = path.join(root, "deployed-copy");

    mkdirSync(upstream);
    git(upstream, "init", "-b", "main");
    configureRepository(upstream);
    writeFileSync(path.join(upstream, "app.txt"), "base\n");
    commitAll(upstream, "Initial release");

    run("git", ["clone", "--bare", upstream, userOrigin], { cwd: root });
    run("git", ["clone", userOrigin, deployedCopy], { cwd: root });
    configureRepository(deployedCopy);

    writeFileSync(path.join(upstream, "release.txt"), "new release\n");
    commitAll(upstream, "Official update");

    const validate = runUpdater(deployedCopy, "validate", root, {
      NSCF_UPSTREAM_URL: upstream,
    });
    assert.equal(validate.status, 0, validate.stderr);
    assert.equal(validate.outputs.update_available, "true");
    assert.ok(validate.outputs.base_sha);
    assert.ok(validate.outputs.upstream_sha);
    assert.ok(validate.outputs.tree_sha);
    const remoteFileBeforeApply = spawnSync(
      "git",
      ["cat-file", "-e", "origin/main:release.txt"],
      { cwd: deployedCopy, encoding: "utf8" },
    );
    assert.notEqual(
      remoteFileBeforeApply.status,
      0,
      "origin must remain unchanged during validation",
    );

    git(deployedCopy, "reset", "--hard", "origin/main");
    const apply = runUpdater(deployedCopy, "apply", root, {
      NSCF_BASE_SHA: validate.outputs.base_sha,
      NSCF_UPSTREAM_SHA: validate.outputs.upstream_sha,
      NSCF_TREE_SHA: validate.outputs.tree_sha,
      NSCF_UPSTREAM_URL: upstream,
    });
    assert.equal(apply.status, 0, apply.stderr);
    assert.equal(
      git(deployedCopy, "show", "origin/main:release.txt"),
      "new release",
    );

    const noUpdate = runUpdater(deployedCopy, "validate", root, {
      NSCF_UPSTREAM_URL: upstream,
    });
    assert.equal(noUpdate.status, 0, noUpdate.stderr);
    assert.equal(noUpdate.outputs.update_available, "false");

    writeFileSync(path.join(deployedCopy, "app.txt"), "user change\n");
    commitAll(deployedCopy, "User customization");
    git(deployedCopy, "push", "origin", "main");
    const userHead = git(deployedCopy, "rev-parse", "HEAD");

    writeFileSync(path.join(upstream, "app.txt"), "official change\n");
    commitAll(upstream, "Conflicting official update");

    const conflict = runUpdater(deployedCopy, "validate", root, {
      NSCF_UPSTREAM_URL: upstream,
    });
    assert.notEqual(conflict.status, 0);
    assert.match(conflict.stderr, /conflicts with changes/);
    assert.equal(git(deployedCopy, "rev-parse", "origin/main"), userHead);
    assert.equal(git(deployedCopy, "rev-parse", "HEAD"), userHead);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
