import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const configUrl = new URL("../wrangler.jsonc", import.meta.url);

test("deployment preserves dashboard variables without storing credentials or adding products", async () => {
  const config = JSON.parse(await readFile(configUrl, "utf8"));

  assert.equal(config.keep_vars, true);
  assert.equal(config.vars, undefined);
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
