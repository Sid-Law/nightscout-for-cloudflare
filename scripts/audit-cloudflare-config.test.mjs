import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const configUrl = new URL("../wrangler.jsonc", import.meta.url);
const packageUrl = new URL("../package.json", import.meta.url);
const readmeUrl = new URL("../README.md", import.meta.url);
const secretExampleUrl = new URL("../.dev.vars.example", import.meta.url);
const nodeVersionUrl = new URL("../.node-version", import.meta.url);

test("deployment preserves dashboard variables without storing credentials or adding products", async () => {
  const config = JSON.parse(await readFile(configUrl, "utf8"));

  assert.equal(config.keep_vars, true);
  assert.equal(config.vars, undefined);
  assert.deepEqual(config.secrets, {
    required: ["API_SECRET", "API_SECRET_CONFIRM"],
  });
  assert.equal(config.kv_namespaces, undefined);
  assert.equal(config.d1_databases, undefined);
  assert.equal(config.r2_buckets, undefined);
  assert.equal(config.queues, undefined);
  assert.equal(config.routes, undefined);
  assert.equal(config.route, undefined);
  assert.equal(config.assets?.binding, "ASSETS");
  assert.deepEqual(config.durable_objects?.bindings, [
    { name: "ENTRY_STORE", class_name: "EntryStore" },
  ]);
});

test("Deploy to Cloudflare template requires a confirmed secret and a clean-source build", async () => {
  const packageJson = JSON.parse(await readFile(packageUrl, "utf8"));
  const readme = await readFile(readmeUrl, "utf8");
  const secretExample = await readFile(secretExampleUrl, "utf8");
  const nodeVersion = (await readFile(nodeVersionUrl, "utf8")).trim();

  assert.equal(
    packageJson.cloudflare?.bindings?.API_SECRET?.description,
    "家庭访问密码（至少 12 个字符）。部署完成后，在手机 Nightscout 数据源中填写同一个密码。",
  );
  assert.equal(
    packageJson.cloudflare?.bindings?.API_SECRET_CONFIRM?.description,
    "请再次输入完全相同的家庭访问密码。两次输入不一致时，Nightscout 会明确报错并拒绝启动。",
  );
  assert.equal(packageJson.scripts?.build, "npm run build:source");
  assert.equal(
    packageJson.scripts?.["build:source"],
    "npm run upstream:install && npm run upstream:bundle && npm run build:ui",
  );
  assert.equal(packageJson.scripts?.deploy, "wrangler deploy");
  assert.equal(
    packageJson.repository?.url,
    "git+https://github.com/Sid-Law/nightscout-for-cloudflare.git",
  );
  assert.match(
    readme,
    /\]\(https:\/\/deploy\.workers\.cloudflare\.com\/\?url=https:\/\/github\.com\/Sid-Law\/nightscout-for-cloudflare\)/,
  );
  assert.equal(nodeVersion, "22.16.0");

  const secretAssignments = secretExample
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  assert.deepEqual(secretAssignments, ["API_SECRET=", "API_SECRET_CONFIRM="]);
});
