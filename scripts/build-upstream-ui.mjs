import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ejs from "ejs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const vendorRoot = path.join(projectRoot, "vendor", "nightscout");
const publicRoot = path.join(projectRoot, "public");
const upstreamBundleRoot = path.join(
  vendorRoot,
  "node_modules",
  ".cache",
  "_ns_cache",
  "public",
);

const manifest = JSON.parse(
  await readFile(path.join(projectRoot, "upstream", "manifest.json"), "utf8"),
);
const cachebuster = `nscf-${manifest.release}-${manifest.commit.slice(0, 12)}`;
const locals = { bundle: "/bundle", cachebuster };

await rm(publicRoot, { recursive: true, force: true });
await mkdir(publicRoot, { recursive: true });

await cp(path.join(vendorRoot, "static"), publicRoot, { recursive: true });
await cp(path.join(vendorRoot, "translations"), path.join(publicRoot, "translations"), {
  recursive: true,
});
await cp(upstreamBundleRoot, path.join(publicRoot, "bundle"), { recursive: true });

const indexPath = path.join(vendorRoot, "views", "index.html");
const indexHtml = await ejs.renderFile(indexPath, {
  locals,
  settings: {},
  title: "",
  type: "index",
});
await writeFile(path.join(publicRoot, "index.html"), indexHtml);

const serviceWorkerPath = path.join(vendorRoot, "views", "service-worker.js");
const serviceWorkerSource = await readFile(serviceWorkerPath, "utf8");
const serviceWorker = ejs.render(serviceWorkerSource, { locals }, { filename: serviceWorkerPath });
await writeFile(path.join(publicRoot, "sw.js"), serviceWorker);

await mkdir(path.join(publicRoot, "socket.io"), { recursive: true });
await cp(
  path.join(projectRoot, "platform", "socket-io-polling-shim.js"),
  path.join(publicRoot, "socket.io", "socket.io.js"),
);

const provenance = {
  generated_at: new Date().toISOString(),
  upstream_release: manifest.release,
  upstream_commit: manifest.commit,
  ui_source: "Official Nightscout assets; no NSCF UI implementation",
  transport_adapter: "/socket.io/socket.io.js",
};
await writeFile(
  path.join(publicRoot, "nscf-upstream.json"),
  `${JSON.stringify(provenance, null, 2)}\n`,
);

console.log(
  JSON.stringify({
    message: "Official Nightscout UI prepared for Workers Static Assets",
    upstream: manifest.release,
    output: publicRoot,
  }),
);
