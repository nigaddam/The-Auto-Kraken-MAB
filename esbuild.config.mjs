// Deliberately esbuild instead of Vite: this project has three entry points
// that need two different output formats (the content script must be a
// classic IIFE script; the service worker and side panel are ES modules),
// plus static files (manifest.json, sidepanel.html/css, icons) copied
// verbatim. esbuild's JS API expresses that directly without fighting a
// bundler built around single-page apps.

import { build, context } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";

const watch = process.argv.includes("--watch");
const outdir = "dist";

async function copyStatic() {
  await mkdir(outdir, { recursive: true });
  await cp("public/manifest.json", `${outdir}/manifest.json`);
  await cp("src/sidepanel/sidepanel.html", `${outdir}/sidepanel.html`);
  await cp("src/sidepanel/sidepanel.css", `${outdir}/sidepanel.css`);
  if (existsSync("icons")) {
    await cp("icons", `${outdir}/icons`, { recursive: true, force: true });
  }
}

const commonOptions = {
  bundle: true,
  sourcemap: true,
  target: "chrome110",
  outdir,
  logLevel: "info",
};

async function run() {
  await rm(outdir, { recursive: true, force: true });
  await copyStatic();

  const contentScript = {
    ...commonOptions,
    entryPoints: { "content-script": "src/content/content-script.ts" },
    format: "iife",
  };
  const serviceWorker = {
    ...commonOptions,
    entryPoints: { "service-worker": "src/background/service-worker.ts" },
    format: "esm",
  };
  const sidepanel = {
    ...commonOptions,
    entryPoints: { sidepanel: "src/sidepanel/sidepanel.ts" },
    format: "esm",
  };

  if (watch) {
    const contexts = await Promise.all(
      [contentScript, serviceWorker, sidepanel].map((cfg) => context(cfg))
    );
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log("Watching for changes... (Ctrl-C to stop)");
  } else {
    await Promise.all([build(contentScript), build(serviceWorker), build(sidepanel)]);
    console.log(`Build complete -> ${outdir}/`);
  }
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
