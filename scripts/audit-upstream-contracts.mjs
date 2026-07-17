import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
export const REPO_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const OVERRIDES_PATH = "upstream/contract-overrides.json";
const UPSTREAM_LOCK_PATH = "upstream/manifest.json";
const MANIFEST_PATH = "upstream/contract-manifest.json";
const MARKDOWN_PATH = "docs/UPSTREAM_TEST_MANIFEST.md";
const TEST_ROOT = "vendor/nightscout/tests";
const KNOWN_STATUSES = new Set([
  "pass",
  "adapted",
  "excluded-fixed-scope",
  "unresolved",
]);
const VERSION_ORDER = new Map([
  ["root", 0],
  ["v1", 1],
  ["v2", 2],
  ["v3", 3],
]);
const METHOD_ORDER = new Map([
  ["GET", 0],
  ["POST", 1],
  ["PUT", 2],
  ["PATCH", 3],
  ["DELETE", 4],
  ["HEAD", 5],
  ["OPTIONS", 6],
  ["ALL", 7],
]);

function readJson(path) {
  return JSON.parse(readFileSync(join(REPO_ROOT, path), "utf8"));
}

function lineNumber(source, index) {
  return source.slice(0, index).split("\n").length;
}

function findClosingDelimiter(source, openIndex, open = "(", close = ")") {
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === open) depth += 1;
    if (character === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error(`Unclosed ${open}${close} delimiter at source offset ${openIndex}`);
}

function splitTopLevel(source) {
  const parts = [];
  let start = 0;
  let round = 0;
  let square = 0;
  let curly = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") round += 1;
    else if (character === ")") round -= 1;
    else if (character === "[") square += 1;
    else if (character === "]") square -= 1;
    else if (character === "{") curly += 1;
    else if (character === "}") curly -= 1;
    else if (character === "," && round === 0 && square === 0 && curly === 0) {
      parts.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(source.slice(start).trim());
  return parts;
}

function decodeStringLiteral(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) return JSON.parse(trimmed);
  if (trimmed.startsWith("'")) {
    const body = trimmed.slice(1, -1);
    return body
      .replaceAll("\\'", "'")
      .replaceAll('\\"', '"')
      .replaceAll("\\n", "\n")
      .replaceAll("\\r", "\r")
      .replaceAll("\\t", "\t")
      .replaceAll("\\\\", "\\");
  }
  if (trimmed.startsWith("`") && !trimmed.includes("${")) return trimmed.slice(1, -1);
  return null;
}

function parsePathArgument(argument) {
  const trimmed = argument.trim();
  const single = decodeStringLiteral(trimmed);
  if (single !== null) return [single];
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  const items = splitTopLevel(trimmed.slice(1, -1));
  const paths = items.map(decodeStringLiteral);
  return paths.every((path) => path !== null) ? paths : null;
}

function permissionStrings(source) {
  const permissions = [];
  const expression = /\.isPermitted\s*\(\s*(['"])(.*?)\1\s*\)/g;
  for (const match of source.matchAll(expression)) permissions.push(match[2]);
  return [...new Set(permissions)].sort();
}

function routerDefaultPermissions(source, routerName) {
  const permissions = [];
  const expression = new RegExp(`\\b${routerName.replaceAll("$", "\\$")}\\.use\\s*\\(`, "g");
  for (const match of source.matchAll(expression)) {
    const openIndex = match.index + match[0].lastIndexOf("(");
    const closeIndex = findClosingDelimiter(source, openIndex);
    permissions.push(...permissionStrings(source.slice(openIndex + 1, closeIndex)));
  }
  return [...new Set(permissions)].sort();
}

export function extractRouteRegistrations(source, sourceFile = "fixture.js") {
  const routes = [];
  const dynamic = [];
  const expression = /\b([A-Za-z_$][A-Za-z0-9_$]*)\.(get|post|put|patch|delete|head|options|all|use)\s*\(/g;

  for (const match of source.matchAll(expression)) {
    const routerName = match[1];
    const registrationMethod = match[2].toLowerCase();
    const method = registrationMethod === "use" ? "ALL" : registrationMethod.toUpperCase();
    const openIndex = match.index + match[0].lastIndexOf("(");
    const closeIndex = findClosingDelimiter(source, openIndex);
    const callSource = source.slice(openIndex + 1, closeIndex);
    const argumentsList = splitTopLevel(callSource);
    if (argumentsList.length < 2) continue;
    const paths = parsePathArgument(argumentsList[0]);
    if (paths === null) {
      // Express treats use(fn, ...) as middleware on the current mount. It is
      // not a dynamic HTTP route unless the first argument is a path.
      if (registrationMethod === "use") continue;
      dynamic.push({
        method,
        registration_method: registrationMethod,
        router_name: routerName,
        path_expression: argumentsList[0],
        source_file: sourceFile,
        source_line: lineNumber(source, match.index),
      });
      continue;
    }
    const permissions = [
      ...routerDefaultPermissions(source, routerName),
      ...permissionStrings(callSource),
    ];
    const uniquePermissions = [...new Set(permissions)].sort();
    const requireMatch = callSource.match(/require\s*\(\s*(['"])(.*?)\1\s*\)/);
    for (const path of paths) {
      routes.push({
        method,
        registration_method: registrationMethod,
        registered_path: path,
        router_name: routerName,
        permissions: uniquePermissions,
        source_file: sourceFile,
        source_line: lineNumber(source, match.index),
        required_module: requireMatch?.[2] ?? null,
      });
    }
  }
  return { routes, dynamic };
}

export function normalizePath(...parts) {
  const joined = parts
    .filter((part) => typeof part === "string" && part.length > 0)
    .join("/")
    .replaceAll(/\/{2,}/g, "/");
  let normalized = joined.startsWith("/") ? joined : `/${joined}`;
  if (normalized.length > 1 && normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  return normalized;
}

function resolveRequiredModule(sourceFile, requiredModule) {
  if (requiredModule === null || !requiredModule.startsWith(".")) return sourceFile;
  const sourceDirectory = dirname(sourceFile);
  const base = normalizePath(sourceDirectory, requiredModule).slice(1);
  for (const candidate of [base, `${base}.js`, join(base, "index.js")]) {
    if (existsSync(join(REPO_ROOT, candidate))) return candidate;
  }
  return sourceFile;
}

function routeKey(route) {
  return `${route.api_version} ${route.method} ${route.path}`;
}

function defaultAuth(permissions) {
  if (permissions.length === 0) {
    return {
      mode: "public",
      credential_required: false,
      permissions: [],
      note: "No explicit authorization middleware is registered on this route.",
    };
  }
  const credentialRequired = permissions.some((permission) => !permission.endsWith(":read"));
  return {
    mode: "nightscout-permission",
    credential_required: credentialRequired,
    permissions,
    note: credentialRequired
      ? "Nightscout resolves request credentials before checking these non-default permissions."
      : "Nightscout resolves request credentials and the DEFAULT read role before checking these permissions.",
  };
}

function staticRoutes(overrides) {
  const output = [];
  const dynamicRisks = [];
  for (const descriptor of overrides.route_modules) {
    const source = readFileSync(join(REPO_ROOT, descriptor.source_file), "utf8");
    const extracted = extractRouteRegistrations(source, descriptor.source_file);
    const allowedPaths = descriptor.only_paths === undefined
      ? null
      : new Set(descriptor.only_paths.map((path) => normalizePath(path)));
    const accepted = extracted.routes.filter((route) => (
      allowedPaths === null || allowedPaths.has(normalizePath(route.registered_path))
    ));
    if (accepted.length === 0) {
      throw new Error(`No routes extracted from ${descriptor.source_file}`);
    }
    for (const apiVersion of descriptor.api_versions) {
      const versionPrefix = overrides.version_prefixes[apiVersion];
      if (versionPrefix === undefined) throw new Error(`Unknown API version ${apiVersion}`);
      for (const route of accepted) {
        const registeredPath = route.registration_method === "use"
          ? normalizePath(route.registered_path, "*")
          : route.registered_path;
        const path = normalizePath(versionPrefix, descriptor.mount_path, registeredPath);
        const built = {
          api_version: apiVersion,
          method: route.method,
          path,
          registration_kind: route.registration_method === "use"
            ? "static-express-prefix"
            : "static-express",
          registration_file: descriptor.registered_by,
          source_file: resolveRequiredModule(descriptor.source_file, route.required_module),
          source_line: route.source_line,
          condition: descriptor.condition ?? "always",
          auth: defaultAuth(route.permissions),
          related_tests: [],
        };
        const key = routeKey(built);
        if (overrides.auth_overrides[key] !== undefined) built.auth = overrides.auth_overrides[key];
        if (overrides.condition_overrides[key] !== undefined) {
          built.condition = overrides.condition_overrides[key];
        }
        output.push(built);
      }
    }
    const routeRouterNames = new Set(extracted.routes.map((route) => route.router_name));
    for (const risk of extracted.dynamic.filter((item) => routeRouterNames.has(item.router_name))) {
      dynamicRisks.push({
        ...risk,
        disposition: "Not emitted from this module without a reviewed manual expansion.",
      });
    }
  }
  return { routes: output, dynamicRisks };
}

function parseConfiguredCollections(group) {
  const source = readFileSync(join(REPO_ROOT, group.collections_source), "utf8");
  const setting = group.collections_setting.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(`app\\.set\\(\\s*['\"]${setting}['\"]\\s*,\\s*\\[([\\s\\S]*?)\\]\\s*\\)`);
  const match = source.match(expression);
  if (match === null) throw new Error(`Cannot find ${group.collections_setting} in ${group.collections_source}`);
  const collections = [];
  for (const item of match[1].matchAll(/(['"])(.*?)\1/g)) collections.push(item[2]);
  if (collections.length === 0) throw new Error(`No collections found in ${group.collections_source}`);
  return collections;
}

function dynamicRoutes(overrides) {
  const routes = [];
  const risks = [];
  for (const group of overrides.dynamic_route_groups) {
    const collections = parseConfiguredCollections(group);
    const versionPrefix = overrides.version_prefixes[group.api_version];
    for (const collection of collections) {
      for (const template of group.routes) {
        const permission = template.permission.replaceAll("{collection}", collection);
        const note = template.auth_note?.replaceAll("{collection}", collection)
          ?? "API v3 authenticates the JWT before checking the collection permission.";
        routes.push({
          api_version: group.api_version,
          method: template.method,
          path: normalizePath(versionPrefix, collection, template.suffix),
          registration_kind: "dynamic-expanded",
          registration_file: group.registration_file,
          source_file: template.source_file,
          source_line: null,
          condition: "collection-enabled",
          auth: {
            mode: "jwt",
            credential_required: true,
            permissions: [permission],
            note,
          },
          related_tests: [],
        });
      }
    }
    risks.push({
      name: group.name,
      collections,
      route_templates: group.routes.length,
      expanded_routes: collections.length * group.routes.length,
      risk: group.risk,
      sources: [group.collections_source, group.registration_file],
    });
  }
  return { routes, risks };
}

function listFilesRecursively(directory) {
  const absolute = join(REPO_ROOT, directory);
  const files = [];
  for (const name of readdirSync(absolute).sort()) {
    const path = join(absolute, name);
    if (statSync(path).isDirectory()) {
      files.push(...listFilesRecursively(relative(REPO_ROOT, path)));
    } else {
      files.push(relative(REPO_ROOT, path));
    }
  }
  return files;
}

function workstreamFor(testFile) {
  const name = testFile.split("/").at(-1).toLowerCase();
  if (/websocket|socket/.test(name)) return "6-realtime";
  if (/api3\.|api3-/.test(name)) return "5-api-v3";
  if (/hashauth|verifyauth|security|identity-matrix/.test(name)) return "2-authorization";
  if (/mongo|storage|query|objectid|uuid|concurrent|deduplication|partial-failures|cache-objectid/.test(name)) {
    return "1-storage-foundation";
  }
  if (/^api\./.test(name)) return "3-api-v1-v2";
  if (/bridge|mmconnect|maker|pushnotify|pushover|notification|bootevent|flakiness|production-safety/.test(name)) {
    return "7-background-and-integrations";
  }
  if (/report|client|profileeditor|language|settings|sandbox|env\./.test(name)) {
    return "8-ui-and-process-boundaries";
  }
  return "4-plugins-and-calculations";
}

function dependencyFor(workstream) {
  const dependencies = {
    "1-storage-foundation": [],
    "2-authorization": ["1-storage-foundation"],
    "3-api-v1-v2": ["1-storage-foundation", "2-authorization"],
    "4-plugins-and-calculations": ["1-storage-foundation"],
    "5-api-v3": ["1-storage-foundation", "2-authorization", "3-api-v1-v2"],
    "6-realtime": ["1-storage-foundation", "2-authorization", "5-api-v3"],
    "7-background-and-integrations": ["1-storage-foundation", "4-plugins-and-calculations"],
    "8-ui-and-process-boundaries": ["3-api-v1-v2", "4-plugins-and-calculations", "6-realtime"],
  };
  return dependencies[workstream];
}

function routeNeedles(route) {
  const withoutParameters = route.path
    .replaceAll(/\/:([^/]+)/g, "")
    .replaceAll("/*", "")
    .replace(/\/$/, "");
  const needles = new Set([withoutParameters]);
  for (const prefix of ["/api/v1", "/api/v2", "/api/v3"]) {
    if (withoutParameters.startsWith(prefix)) {
      const suffix = withoutParameters.slice(prefix.length) || "/";
      needles.add(suffix);
      if (prefix === "/api/v1" || prefix === "/api/v2") needles.add(`/api${suffix}`);
    }
  }
  return [...needles].filter((needle) => needle.length >= 4);
}

function operationTestHints(route) {
  if (route.api_version !== "v3") return [];
  if (route.path.includes("/history")) return ["api3.generic.workflow", "api3.storage.find"];
  if (route.path.includes(":")) {
    if (route.method === "GET") return ["api3.read"];
    if (route.method === "PUT") return ["api3.update"];
    if (route.method === "PATCH") return ["api3.patch"];
    if (route.method === "DELETE") return ["api3.delete"];
  }
  if (route.method === "GET") return ["api3.search"];
  if (route.method === "POST") return ["api3.create"];
  return [];
}

function associateTests(routes, testFiles) {
  const testContents = new Map(testFiles.map((testFile) => [
    testFile,
    readFileSync(join(REPO_ROOT, testFile), "utf8").toLowerCase(),
  ]));
  for (const route of routes) {
    const needles = routeNeedles(route).map((needle) => needle.toLowerCase());
    const hints = operationTestHints(route);
    route.related_tests = testFiles.filter((testFile) => {
      const content = testContents.get(testFile);
      const basename = testFile.split("/").at(-1).toLowerCase();
      return needles.some((needle) => content.includes(needle))
        || hints.some((hint) => basename.includes(hint));
    });
  }
}

function buildTests(overrides, routes) {
  const testFiles = listFilesRecursively(TEST_ROOT)
    .filter((path) => path.endsWith(".test.js"))
    .sort();
  associateTests(routes, testFiles);
  const reverseRoutes = new Map(testFiles.map((testFile) => [testFile, []]));
  for (const route of routes) {
    for (const testFile of route.related_tests) reverseRoutes.get(testFile).push(routeKey(route));
  }
  return testFiles.map((testFile) => {
    const override = overrides.test_status_overrides[testFile] ?? overrides.test_defaults;
    const workstream = workstreamFor(testFile);
    return {
      file: testFile,
      status: override.status,
      reason: override.reason,
      workstream,
      depends_on: dependencyFor(workstream),
      related_routes: reverseRoutes.get(testFile).sort(),
    };
  });
}

function countBy(items, keyFunction) {
  const output = {};
  for (const item of items) {
    const key = keyFunction(item);
    output[key] = (output[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(output).sort(([a], [b]) => a.localeCompare(b)));
}

function countTestStatuses(tests) {
  const counts = Object.fromEntries([...KNOWN_STATUSES].map((status) => [status, 0]));
  for (const test of tests) counts[test.status] += 1;
  return counts;
}

function inputDigest(paths) {
  const digest = createHash("sha256");
  for (const path of [...new Set(paths)].sort()) {
    digest.update(path);
    digest.update("\0");
    digest.update(readFileSync(join(REPO_ROOT, path)));
    digest.update("\0");
  }
  return digest.digest("hex");
}

function compareRoutes(left, right) {
  return (VERSION_ORDER.get(left.api_version) - VERSION_ORDER.get(right.api_version))
    || left.path.localeCompare(right.path)
    || (METHOD_ORDER.get(left.method) - METHOD_ORDER.get(right.method))
    || left.source_file.localeCompare(right.source_file);
}

export function assertNoDuplicateRoutes(routes) {
  const seen = new Map();
  for (const route of routes) {
    const key = routeKey(route);
    if (seen.has(key)) {
      throw new Error(`Duplicate route ${key}: ${seen.get(key)} and ${route.source_file}`);
    }
    seen.set(key, route.source_file);
  }
}

export function validateManifest(manifest, overrides = readJson(OVERRIDES_PATH)) {
  if (manifest.tests.length !== overrides.expected_test_count) {
    throw new Error(`Expected ${overrides.expected_test_count} tests, found ${manifest.tests.length}`);
  }
  assertNoDuplicateRoutes(manifest.routes);
  if (manifest.unexpanded_dynamic_registrations.length > 0) {
    throw new Error("Unexpanded dynamic route registrations require a reviewed manual override");
  }
  const sortedRoutes = [...manifest.routes].sort(compareRoutes);
  if (JSON.stringify(sortedRoutes) !== JSON.stringify(manifest.routes)) {
    throw new Error("Routes are not in deterministic order");
  }
  const sortedTests = [...manifest.tests].sort((left, right) => (
    left.file < right.file ? -1 : left.file > right.file ? 1 : 0
  ));
  if (JSON.stringify(sortedTests) !== JSON.stringify(manifest.tests)) {
    throw new Error("Tests are not in deterministic order");
  }
  for (const route of manifest.routes) {
    for (const path of [route.registration_file, route.source_file]) {
      if (!existsSync(join(REPO_ROOT, path))) throw new Error(`Missing route source ${path}`);
    }
  }
  for (const test of manifest.tests) {
    if (!KNOWN_STATUSES.has(test.status)) throw new Error(`Unknown status ${test.status} for ${test.file}`);
    if (test.reason.trim().length === 0) throw new Error(`Missing reason for ${test.file}`);
    if (!existsSync(join(REPO_ROOT, test.file))) throw new Error(`Missing test file ${test.file}`);
  }
  if (manifest.statistics.route_count !== manifest.routes.length) {
    throw new Error("Route statistics do not match the route inventory");
  }
  for (const status of KNOWN_STATUSES) {
    const actual = manifest.tests.filter((test) => test.status === status).length;
    if (manifest.statistics.tests_by_status[status] !== actual) {
      throw new Error(`Status statistics do not match for ${status}`);
    }
  }
  const testNames = new Set(manifest.tests.map((test) => test.file));
  for (const overridden of Object.keys(overrides.test_status_overrides)) {
    if (!testNames.has(overridden)) throw new Error(`Status override targets unknown test ${overridden}`);
  }
  return manifest;
}

export function buildManifest() {
  const overrides = readJson(OVERRIDES_PATH);
  const upstream = readJson(UPSTREAM_LOCK_PATH);
  const staticResult = staticRoutes(overrides);
  const dynamicResult = dynamicRoutes(overrides);
  const routes = [...staticResult.routes, ...dynamicResult.routes].sort(compareRoutes);
  const tests = buildTests(overrides, routes);
  const inputPaths = [
    "scripts/audit-upstream-contracts.mjs",
    OVERRIDES_PATH,
    UPSTREAM_LOCK_PATH,
    ...overrides.route_modules.flatMap((module) => [module.source_file, module.registered_by]),
    ...overrides.dynamic_route_groups.flatMap((group) => [
      group.collections_source,
      group.registration_file,
      ...group.routes.map((route) => route.source_file),
    ]),
    ...tests.map((test) => test.file),
  ];
  const manifest = {
    schema_version: 1,
    generated_by: "scripts/audit-upstream-contracts.mjs",
    baseline: {
      project: upstream.project,
      release: upstream.release,
      commit: upstream.commit,
      vendor_path: upstream.vendor_path,
    },
    policy: {
      pass_definition: "pass means the complete upstream test file runs unchanged and passes against NSCF",
      adapted_definition: "adapted means every contract in the upstream file is represented by a named passing Workers-runtime adapter test",
      default_status: overrides.test_defaults.status,
      fixed_scope: "Only tests exclusively covering real-CGM bridges or external push delivery may be excluded-fixed-scope; storage, API, auth, realtime, calculations, and UI contracts remain implementation work.",
      route_method_scope: "The manifest records explicit Express registrations. Express-derived HEAD/OPTIONS behavior and extension middleware variants are not expanded into duplicate rows.",
    },
    inputs_sha256: inputDigest(inputPaths),
    statistics: {
      route_count: routes.length,
      routes_by_version: countBy(routes, (route) => route.api_version),
      routes_by_method: countBy(routes, (route) => route.method),
      test_file_count: tests.length,
      tests_by_status: countTestStatuses(tests),
      tests_by_workstream: countBy(tests, (test) => test.workstream),
    },
    dynamic_route_risks: dynamicResult.risks,
    unexpanded_dynamic_registrations: staticResult.dynamicRisks,
    routes,
    tests,
  };
  return validateManifest(manifest, overrides);
}

export function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function markdownEscape(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function renderMarkdown(manifest) {
  const lines = [
    "# Upstream test manifest",
    "",
    "> Generated by `npm run upstream:audit`. Do not edit this file by hand; edit `upstream/contract-overrides.json` or the generator instead.",
    "",
    `Locked upstream: \`${manifest.baseline.project}\` ${manifest.baseline.release} at \`${manifest.baseline.commit}\`.`,
    "",
    "## Audit summary",
    "",
    `- Routes: ${manifest.statistics.route_count} (${Object.entries(manifest.statistics.routes_by_version).map(([key, value]) => `${key}: ${value}`).join(", ")})`,
    `- Upstream test files: ${manifest.statistics.test_file_count}`,
    `- Statuses: ${Object.entries(manifest.statistics.tests_by_status).map(([key, value]) => `${key}: ${value}`).join(", ")}`,
    `- Input fingerprint: \`${manifest.inputs_sha256}\``,
    "",
    "`pass` is intentionally strict: the whole upstream file must run unchanged. `adapted` requires every contract in that file to be represented by named passing Workers-runtime tests. A partial local implementation therefore remains `unresolved`.",
    "",
    "Fixed-scope exclusions are limited to real-CGM bridges and external push delivery. Everything else below remains required implementation work even when it depends on Mongo/Express/Socket.IO/process-lifetime adaptation.",
    "",
    "## Dependency-ordered workstreams",
    "",
    "| Workstream | Depends on | Files | Unresolved | Fixed-scope excluded |",
    "| --- | --- | ---: | ---: | ---: |",
  ];
  const workstreams = [...new Set(manifest.tests.map((test) => test.workstream))].sort();
  for (const workstream of workstreams) {
    const tests = manifest.tests.filter((test) => test.workstream === workstream);
    const dependencies = tests[0].depends_on.join(", ") || "none";
    lines.push(`| ${workstream} | ${dependencies} | ${tests.length} | ${tests.filter((test) => test.status === "unresolved").length} | ${tests.filter((test) => test.status === "excluded-fixed-scope").length} |`);
  }
  lines.push(
    "",
    "Dispatch work in numeric order. Within a workstream, use each test's `related_routes` in `upstream/contract-manifest.json` to group compatible implementation slices.",
    "",
    "## Dynamic route risk",
    "",
  );
  for (const risk of manifest.dynamic_route_risks) {
    lines.push(`- **${risk.name}:** ${risk.expanded_routes} routes expanded from ${risk.collections.length} collections and ${risk.route_templates} reviewed templates. ${risk.risk}`);
  }
  lines.push(
    "",
    "The check command also rejects duplicate method/path pairs, missing source files, an upstream test count other than 111, unknown statuses, stale generated output, and nondeterministic ordering.",
    "",
    "## Complete upstream test-file status",
    "",
  );
  for (const workstream of workstreams) {
    lines.push(
      `### ${workstream}`,
      "",
      "| Test file | Status | Related routes | Reason |",
      "| --- | --- | ---: | --- |",
    );
    for (const test of manifest.tests.filter((item) => item.workstream === workstream)) {
      lines.push(`| \`${test.file}\` | ${test.status} | ${test.related_routes.length} | ${markdownEscape(test.reason)} |`);
    }
    lines.push("");
  }
  lines.push(
    "## Commands",
    "",
    "```sh",
    "npm run upstream:audit",
    "npm run upstream:audit:check",
    "npm run test:upstream-audit",
    "```",
    "",
  );
  return lines.join("\n");
}

function checkFile(path, expected) {
  const absolute = join(REPO_ROOT, path);
  if (!existsSync(absolute)) throw new Error(`${path} is missing; run npm run upstream:audit`);
  const actual = readFileSync(absolute, "utf8");
  if (actual !== expected) throw new Error(`${path} is stale; run npm run upstream:audit`);
}

function main() {
  const manifest = buildManifest();
  const serialized = serializeManifest(manifest);
  const markdown = renderMarkdown(manifest);
  if (process.argv.includes("--check")) {
    checkFile(MANIFEST_PATH, serialized);
    checkFile(MARKDOWN_PATH, markdown);
    console.log(`Upstream audit is current: ${manifest.statistics.route_count} routes, ${manifest.statistics.test_file_count} test files.`);
    return;
  }
  writeFileSync(join(REPO_ROOT, MANIFEST_PATH), serialized);
  writeFileSync(join(REPO_ROOT, MARKDOWN_PATH), markdown);
  console.log(`Generated ${MANIFEST_PATH} and ${MARKDOWN_PATH}: ${manifest.statistics.route_count} routes, ${manifest.statistics.test_file_count} test files.`);
}

if (resolve(process.argv[1] ?? "") === SCRIPT_PATH) main();
