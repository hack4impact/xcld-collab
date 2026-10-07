import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const scratchRoot = path.join(repoRoot, ".scratch", "browser-harness");
const playwrightPackageRoot = process.env.PLAYWRIGHT_PACKAGE_DIR
  ? path.resolve(process.env.PLAYWRIGHT_PACKAGE_DIR)
  : path.join(repoRoot, ".scratch", "playwright", "node_modules", "playwright");

const resolvePlaywright = () => {
  try {
    return require("playwright");
  } catch {
    return require(path.join(playwrightPackageRoot, "index.js"));
  }
};

const buildBundle = async () => {
  await mkdir(scratchRoot, { recursive: true });
  const appScratch = path.join(repoRoot, "app", ".scratch");
  await mkdir(appScratch, { recursive: true });
  const esbuildBin = path.join(repoRoot, "app", "node_modules", "esbuild", "bin", "esbuild");
  const entry = path.join(appScratch, "browser-entry.mjs");
  await writeFile(entry, await readFile(path.join(repoRoot, "tests", "browser", "browser-entry.mjs"), "utf8"), "utf8");
  const outfile = path.join(scratchRoot, "bundle.js");
  const result = spawnSync(process.execPath, [
    esbuildBin,
    entry,
    "--bundle",
    "--format=iife",
    "--global-name=MermaidHarness",
    "--platform=browser",
    "--sourcemap=inline",
    "--define:process.env.NODE_ENV=\"production\"",
    `--outfile=${outfile}`,
  ], { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`esbuild failed\n${result.stdout}\n${result.stderr}`);
  }
  await writeFile(path.join(scratchRoot, "index.html"), "<!doctype html><meta charset=\"utf-8\"><title>Mermaid harness</title><script src=\"bundle.js\"></script>\n", "utf8");
};

const serve = async (port) => new Promise((resolve, reject) => {
  const server = createServer(async (request, response) => {
    const urlPath = new URL(request.url ?? "/", `http://127.0.0.1:${port}`).pathname;
    const file = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
    try {
      const data = await import("node:fs/promises").then((fs) => fs.readFile(path.join(scratchRoot, file)));
      response.writeHead(200, { "content-type": file.endsWith(".js") ? "text/javascript" : "text/html" });
      response.end(data);
    } catch {
      response.writeHead(404);
      response.end("not found");
    }
  });
  server.on("error", reject);
  server.listen(port, "127.0.0.1", () => resolve(server));
});

export const main = async (argv = process.argv.slice(2)) => {
  const portIndex = argv.indexOf("--port");
  const port = portIndex >= 0 ? Number(argv[portIndex + 1]) : 3121;
  const outIndex = argv.indexOf("--out");
  const outFile = outIndex >= 0 ? path.resolve(argv[outIndex + 1]) : null;
  const fixtureIndex = argv.indexOf("--fixture");
  const fixtureCase = fixtureIndex >= 0 ? argv[fixtureIndex + 1] : null;
  const skipBuild = argv.includes("--skip-build");
  const appMode = argv.includes("--app");
  const buildOnly = argv.includes("--build-only");

  if (!skipBuild) await buildBundle();
  if (buildOnly) return;
  const { chromium } = resolvePlaywright();
  const server = await serve(port);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const consoleMessages = [];
  const pageErrors = [];
  page.on("console", async (message) => {
    const values = [];
    for (const arg of message.args()) {
      try {
        values.push(await arg.evaluate((value) => {
          if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
          if (typeof value === "object" && value !== null) return JSON.stringify(value);
          return String(value);
        }));
      } catch (error) {
        values.push(`<<unserializable: ${error instanceof Error ? error.message : String(error)}>>`);
      }
    }
    consoleMessages.push({ type: message.type(), text: message.text(), values });
  });
  page.on("pageerror", (error) => pageErrors.push({ name: error.name, message: error.message, stack: error.stack }));

  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
    const result = fixtureCase
      ? await page.evaluate(([name, app]) => (app ? globalThis.MermaidHarness.appScene(name) : globalThis.MermaidHarness.convertedScene(name)), [fixtureCase, appMode])
      : await page.evaluate(() => globalThis.MermaidHarness.runAll());
    const output = fixtureCase ? result : { result, consoleMessages, pageErrors };
    const json = JSON.stringify(output, null, 2);
    if (outFile) await writeFile(outFile, `${json}\n`, "utf8");
    console.log(json);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
