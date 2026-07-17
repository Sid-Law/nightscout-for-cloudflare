import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertNoDuplicateRoutes,
  buildManifest,
  extractRouteRegistrations,
  normalizePath,
  serializeManifest,
  validateManifest,
} from "./audit-upstream-contracts.mjs";

test("extracts literal and array Express routes while ignoring app settings getters", () => {
  const source = `
    const router = express.Router();
    router.use(auth.isPermitted('api:entries:read'));
    app.get('env');
    router.get(['/', '/:id'], handler);
    router.post('/items', auth.isPermitted('api:entries:create'), handler);
  `;
  const extracted = extractRouteRegistrations(source, "fixture.js");
  assert.equal(extracted.routes.length, 3);
  assert.deepEqual(extracted.routes.map((route) => route.registered_path), ["/", "/:id", "/items"]);
  assert.deepEqual(extracted.routes[0].permissions, ["api:entries:read"]);
  assert.deepEqual(extracted.routes[2].permissions, ["api:entries:create", "api:entries:read"]);
});

test("normalizes mounted paths deterministically", () => {
  assert.equal(normalizePath("/api/v2/", "/properties", "/*"), "/api/v2/properties/*");
  assert.equal(normalizePath("/api/v1", "", "/entries/"), "/api/v1/entries");
});

test("duplicate method/path pairs are rejected", () => {
  const route = {
    api_version: "v1",
    method: "GET",
    path: "/api/v1/status",
    source_file: "first.js",
  };
  assert.throws(() => assertNoDuplicateRoutes([route, { ...route, source_file: "second.js" }]), /Duplicate route/);
});

test("the locked repository manifest is stable and validates all 111 test files", () => {
  const first = buildManifest();
  const second = buildManifest();
  validateManifest(first);
  assert.equal(first.tests.length, 111);
  assert.equal(serializeManifest(first), serializeManifest(second));
  assert.equal(first.tests.filter((item) => item.status === "pass").length, 0);
  assert.equal(first.tests.filter((item) => item.status === "adapted").length, 0);
  assert.deepEqual(
    first.tests
      .filter((item) => item.status === "excluded-fixed-scope")
      .map((item) => item.file),
    [
      "vendor/nightscout/tests/bridge.test.js",
      "vendor/nightscout/tests/mmconnect.test.js",
    ],
  );
  for (const file of [
    "vendor/nightscout/tests/maker.test.js",
    "vendor/nightscout/tests/pushnotify.test.js",
    "vendor/nightscout/tests/pushover.test.js",
  ]) {
    assert.equal(first.tests.find((item) => item.file === file)?.status, "unresolved", file);
  }
});
