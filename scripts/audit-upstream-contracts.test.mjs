import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  REPO_ROOT,
  assertExactOverlaySet,
  assertLockedSourceHash,
  assertNoDuplicateRoutes,
  buildManifest,
  extractDynamicRouteTemplates,
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

test("reviewed overlays reject additions, removals, and duplicates", () => {
  assert.doesNotThrow(() => assertExactOverlaySet("fixture", ["GET /", "POST /"], ["POST /", "GET /"]));
  assert.throws(() => assertExactOverlaySet("fixture", ["GET /"], ["GET /", "POST /"]), /overlay drift/);
  assert.throws(() => assertExactOverlaySet("fixture", ["GET /", "POST /"], ["GET /"]), /overlay drift/);
  assert.throws(() => assertExactOverlaySet("fixture", ["GET /"], ["GET /", "GET /"]), /overlay drift/);
});

test("the API3 only_paths overlay equals the five locked static registrations", () => {
  const overrides = JSON.parse(readFileSync(join(REPO_ROOT, "upstream/contract-overrides.json"), "utf8"));
  const descriptor = overrides.route_modules.find((module) => module.source_file.endsWith("/api3/index.js"));
  const source = readFileSync(join(REPO_ROOT, descriptor.source_file), "utf8");
  assert.doesNotThrow(() => assertLockedSourceHash(descriptor.source_file, source, descriptor.source_sha256));
  assert.throws(
    () => assertLockedSourceHash(descriptor.source_file, `${source}\n`, descriptor.source_sha256),
    /source hash drift/,
  );
  const routes = extractRouteRegistrations(source, descriptor.source_file).routes;
  assertExactOverlaySet(
    "api3 only_paths fixture",
    descriptor.only_paths.map((path) => normalizePath(path)),
    routes.map((route) => normalizePath(route.registered_path)),
  );
  const signatures = routes.map((route) => `${route.method} ${route.registered_path}`);
  assert.deepEqual(signatures, [
    "GET /version",
    "GET /test",
    "GET /lastModified",
    "GET /status",
    "ALL /swagger-ui-dist",
  ]);
  assertExactOverlaySet("api3 only_routes fixture", descriptor.only_routes, signatures);
  assert.throws(
    () => assertExactOverlaySet(
      "api3 only_routes fixture",
      descriptor.only_routes,
      ["POST /version", ...signatures.slice(1)],
    ),
    /overlay drift/,
  );
});

test("the API3 overlay is anchored to all eight locked dynamic registrations", () => {
  const sourceFile = "vendor/nightscout/lib/api3/generic/collection.js";
  const source = readFileSync(join(REPO_ROOT, sourceFile), "utf8");
  const overrides = JSON.parse(readFileSync(join(REPO_ROOT, "upstream/contract-overrides.json"), "utf8"));
  const group = overrides.dynamic_route_groups.find((item) => item.registration_file === sourceFile);
  assert.doesNotThrow(() => assertLockedSourceHash(sourceFile, source, group.registration_sha256));
  assert.throws(() => assertLockedSourceHash(sourceFile, `${source}\n`, group.registration_sha256), /source hash drift/);
  assert.deepEqual(extractDynamicRouteTemplates(source, sourceFile), [
    {
      method: "GET",
      suffix: "",
      source_file: "vendor/nightscout/lib/api3/generic/search/operation.js",
      handler_name: "searchOperation",
      registration_line: 50,
    },
    {
      method: "POST",
      suffix: "",
      source_file: "vendor/nightscout/lib/api3/generic/create/operation.js",
      handler_name: "createOperation",
      registration_line: 53,
    },
    {
      method: "GET",
      suffix: "/history",
      source_file: "vendor/nightscout/lib/api3/generic/history/operation.js",
      handler_name: "historyOperation",
      registration_line: 56,
    },
    {
      method: "GET",
      suffix: "/history/:lastModified",
      source_file: "vendor/nightscout/lib/api3/generic/history/operation.js",
      handler_name: "historyOperation",
      registration_line: 59,
    },
    {
      method: "GET",
      suffix: "/:identifier",
      source_file: "vendor/nightscout/lib/api3/generic/read/operation.js",
      handler_name: "readOperation",
      registration_line: 62,
    },
    {
      method: "PUT",
      suffix: "/:identifier",
      source_file: "vendor/nightscout/lib/api3/generic/update/operation.js",
      handler_name: "updateOperation",
      registration_line: 65,
    },
    {
      method: "PATCH",
      suffix: "/:identifier",
      source_file: "vendor/nightscout/lib/api3/generic/patch/operation.js",
      handler_name: "patchOperation",
      registration_line: 68,
    },
    {
      method: "DELETE",
      suffix: "/:identifier",
      source_file: "vendor/nightscout/lib/api3/generic/delete/operation.js",
      handler_name: "deleteOperation",
      registration_line: 71,
    },
  ]);
  assert.throws(
    () => extractDynamicRouteTemplates(`${source}\napp.get('/unexpected', handler);\n`, sourceFile),
    /unexpected literal registrations/,
  );
  assert.throws(
    () => extractDynamicRouteTemplates(`${source}\nrouter.get(prefix, handler);\n`, sourceFile),
    /unexpected router registrations/,
  );
  for (const routerName of ["app", "router"]) {
    assert.throws(
      () => extractDynamicRouteTemplates(`${source}\n${routerName}.use(prefix, handler);\n`, sourceFile),
      /unexpected dynamic use registrations/,
    );
  }
});

test("the locked repository manifest is stable and validates all 111 test files", () => {
  const first = buildManifest();
  const second = buildManifest();
  validateManifest(first);
  assert.equal(first.tests.length, 111);
  assert.equal(serializeManifest(first), serializeManifest(second));
  assert.equal(first.tests.filter((item) => item.status === "pass").length, 0);
  assert.equal(first.tests.filter((item) => item.status === "adapted").length, 0);
  assert.deepEqual(first.statistics.tests_by_status, {
    pass: 0,
    adapted: 0,
    "excluded-fixed-scope": 2,
    unresolved: 109,
  });
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

test("default readable auth does not grant four-part admin read permissions", () => {
  const manifest = buildManifest();
  const expected = new Map([
    ["/api/v2/authorization/permissions", "admin:api:permissions:read"],
    ["/api/v2/authorization/permissions/trie", "admin:api:permissions:read"],
    ["/api/v2/authorization/subjects", "admin:api:subjects:read"],
  ]);
  for (const [path, permission] of expected) {
    const route = manifest.routes.find((item) => item.method === "GET" && item.path === path);
    assert.ok(route, path);
    assert.equal(route.auth.mode, "nightscout-permission", path);
    assert.equal(route.auth.credential_required, true, path);
    assert.deepEqual(route.auth.permissions, [permission], path);
  }

  const readable = manifest.routes.find((item) => item.method === "GET" && item.path === "/api/v1/entries");
  assert.ok(readable);
  assert.deepEqual(readable.auth.permissions, ["api:entries:read"]);
  assert.equal(readable.auth.credential_required, false);
  assert.deepEqual(manifest.policy.default_anonymous_permissions, ["*:*:read"]);
});

test("API3 PUT identifier routes record both conditional upsert permission branches", () => {
  const manifest = buildManifest();
  const routes = manifest.routes.filter((route) => (
    route.api_version === "v3"
      && route.registration_kind === "dynamic-expanded"
      && route.method === "PUT"
      && route.path.endsWith("/:identifier")
  ));
  assert.equal(routes.length, 6);
  for (const route of routes) {
    const collection = route.path.split("/")[3];
    assert.deepEqual(route.auth.permissions, [
      `api:${collection}:create`,
      `api:${collection}:update`,
    ]);
    assert.match(route.auth.note, /existing document requires .*:update/i);
    assert.match(route.auth.note, /no existing document matches .* requires .*:create/i);
  }
});

test("provenance keeps mount, registration, and handler file-line pairs distinct", () => {
  const manifest = buildManifest();
  const route = manifest.routes.find((item) => item.method === "GET" && item.path === "/api/v3/version");
  assert.ok(route);
  assert.deepEqual({
    mount_file: route.mount_file,
    mount_line: route.mount_line,
    registration_file: route.registration_file,
    registration_line: route.registration_line,
    source_file: route.source_file,
    source_line: route.source_line,
  }, {
    mount_file: "vendor/nightscout/lib/server/app.js",
    mount_line: 249,
    registration_file: "vendor/nightscout/lib/api3/index.js",
    registration_line: 78,
    source_file: "vendor/nightscout/lib/api3/specific/version.js",
    source_line: 11,
  });
  const sourceLine = (file, line) => readFileSync(join(REPO_ROOT, file), "utf8").split("\n")[line - 1];
  assert.match(sourceLine(route.mount_file, route.mount_line), /app\.use\('\/api\/v3'/);
  assert.match(sourceLine(route.registration_file, route.registration_line), /app\.get\('\/version'/);
  assert.match(sourceLine(route.source_file, route.source_line), /api\.get\('\/version'/);
});

test("related route links are boundary-aware heuristic candidates", () => {
  const manifest = buildManifest();
  const findRoute = (path, method = "GET") => manifest.routes.find((route) => (
    route.path === path && route.method === method
  ));
  const rootVersion = findRoute("/api/versions");
  const api3Version = findRoute("/api/v3/version");
  const api3Entries = findRoute("/api/v3/entries");
  const api3Read = findRoute("/api/v3/entries/:identifier");
  const v1DeviceStatus = findRoute("/api/v1/devicestatus");
  const v2DeviceStatus = findRoute("/api/v2/devicestatus");
  assert.deepEqual(rootVersion.related_tests, ["vendor/nightscout/tests/api.root.test.js"]);
  assert.deepEqual(api3Version.related_tests, ["vendor/nightscout/tests/api3.basic.test.js"]);
  assert.ok(api3Entries.related_tests.includes("vendor/nightscout/tests/api3.search.test.js"));
  assert.deepEqual(api3Read.related_tests, ["vendor/nightscout/tests/api3.read.test.js"]);
  for (const route of [v1DeviceStatus, v2DeviceStatus]) {
    assert.ok(!route.related_tests.includes("vendor/nightscout/tests/api3.shape-handling.test.js"), route.path);
  }
  for (const route of manifest.routes.filter((item) => (
    item.api_version === "v3" && item.registration_kind !== "dynamic-expanded" && item.method === "GET"
  ))) {
    assert.ok(!route.related_tests.includes("vendor/nightscout/tests/api3.search.test.js"), route.path);
  }
  assert.match(manifest.policy.related_test_association, /heuristic candidates/i);
});
