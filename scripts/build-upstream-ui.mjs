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
const cachebuster = `${manifest.release}-${manifest.commit.slice(0, 12)}`;
const locals = { bundle: "/bundle", cachebuster };

await rm(publicRoot, { recursive: true, force: true });
await mkdir(publicRoot, { recursive: true });

await cp(path.join(vendorRoot, "static"), publicRoot, { recursive: true });
await cp(path.join(vendorRoot, "translations"), path.join(publicRoot, "translations"), {
  recursive: true,
});
await cp(upstreamBundleRoot, path.join(publicRoot, "bundle"), { recursive: true });

const officialPages = [
  { view: "index.html", output: "index.html", title: "", type: "index" },
  {
    view: "adminindex.html",
    output: "admin/index.html",
    title: "Admin Tools",
    type: "admin",
  },
  {
    view: "profileindex.html",
    output: "profile/index.html",
    title: "Profile Editor",
    type: "profile",
  },
  {
    view: "foodindex.html",
    output: "food/index.html",
    title: "Food Editor",
    type: "food",
  },
  {
    view: "reportindex.html",
    output: "report/index.html",
    title: "Nightscout reporting",
    type: "report",
  },
  {
    view: "frame.html",
    output: "split/index.html",
    title: "8-user view",
    type: "index",
  },
];

for (const page of officialPages) {
  const viewPath = path.join(vendorRoot, "views", page.view);
  const html = await ejs.renderFile(viewPath, {
    locals,
    settings: {},
    title: page.title,
    type: page.type,
  });
  const outputPath = path.join(publicRoot, page.output);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html);
}

const clockViewPath = path.join(vendorRoot, "views", "clockviews", "clock.html");
for (const face of ["bgclock", "clock-color", "clock", "config"]) {
  const html = await ejs.renderFile(clockViewPath, { face, locals });
  const outputPath = path.join(publicRoot, "clock", face, "index.html");
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html);
}
const clockTemplate = await ejs.renderFile(clockViewPath, {
  face: "__CLOCK_FACE__",
  locals,
});
await writeFile(path.join(publicRoot, "clock", "template.html"), clockTemplate);

const serviceWorkerPath = path.join(vendorRoot, "views", "service-worker.js");
const serviceWorkerSource = await readFile(serviceWorkerPath, "utf8");
const serviceWorker = ejs.render(serviceWorkerSource, { locals }, { filename: serviceWorkerPath });
await writeFile(path.join(publicRoot, "sw.js"), serviceWorker);

await mkdir(path.join(publicRoot, "socket.io"), { recursive: true });
await cp(
  path.join(projectRoot, "platform", "socket-io-polling-shim.js"),
  path.join(publicRoot, "socket.io", "socket.io.js"),
);
await mkdir(path.join(publicRoot, "api-docs"), { recursive: true });
await cp(
  path.join(vendorRoot, "static", "api-docs.html"),
  path.join(publicRoot, "api-docs", "index.html"),
);
await cp(
  path.join(vendorRoot, "node_modules", "swagger-ui-dist"),
  path.join(publicRoot, "swagger-ui-dist"),
  { recursive: true },
);
await cp(
  path.join(vendorRoot, "lib", "server", "swagger.json"),
  path.join(publicRoot, "swagger.json"),
);
await cp(
  path.join(vendorRoot, "lib", "server", "swagger.yaml"),
  path.join(publicRoot, "swagger.yaml"),
);
await cp(
  path.join(vendorRoot, "lib", "api3", "swagger.json"),
  path.join(publicRoot, "api3-swagger.json"),
);

console.log(
  JSON.stringify({
    message: "Official Nightscout UI prepared for Workers Static Assets",
    upstream: manifest.release,
    output: publicRoot,
  }),
);
