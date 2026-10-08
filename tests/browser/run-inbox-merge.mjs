// Headless Chromium check of the tab side of Mermaid ingestion (slice 6a), against a running
// canvas. A developer check, not the lead's acceptance test, and not part of `node --test tests`.
// See README.md in this folder.
//
//   node tests/browser/run-inbox-merge.mjs --url http://127.0.0.1:3211 [--shots <dir>] [--container <name>]
//
// 1. hand-drawn: a board with a human's drawing is open in a tab; an agent writes Mermaid. The tab
//    lays it out in memory and posts it back; the server adds it below the drawing as the agent,
//    at the agent's write time. The human's shapes stay; the next write applies with no tab.
// 2. empty: a blank board is open; the Mermaid becomes the board at the converter's layout.
// 3. source: a second, LR diagram under source "side" goes right of the drawing, ids prefixed.
// Boards go under sandbox/inbox-merge/<run>-*. With --container, history authors are read with
// `docker exec <container> xcld history export <board> --json`.
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
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

const argv = process.argv.slice(2);
const option = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const baseUrl = String(option("--url", "")).replace(/\/+$/, "");
if (!baseUrl) {
  console.error("usage: node tests/browser/run-inbox-merge.mjs --url http://127.0.0.1:<port> [--shots <dir>] [--container <name>]");
  process.exit(2);
}
const shotsDir = path.resolve(option("--shots", path.join(repoRoot, ".scratch", "inbox-merge")));
const container = option("--container");
const run = Date.now().toString(36);
const AGENT = "agent:inbox-check#c0ffee";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (what, check, ms = 30_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(150);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const boardPath = (board) => board.split("/").map(encodeURIComponent).join("/");
const read = async (board) => {
  const response = await fetch(`${baseUrl}/api/board/${boardPath(board)}`);
  return response.ok ? { version: response.headers.get("etag").replaceAll("\"", ""), elements: (await response.json()).elements } : null;
};
const post = async (url, body) => {
  const response = await fetch(`${baseUrl}${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { httpStatus: response.status, ...(await response.json()) };
};
const status = async (board, id) => (await fetch(`${baseUrl}/api/mermaid/${boardPath(board)}?id=${id}`)).json();
const history = (board) => {
  if (!container) return null;
  const result = spawnSync("docker", ["exec", container, "xcld", "history", "export", board, "--json"], { encoding: "utf8" });
  if (result.status !== 0) return { error: result.stderr.trim() };
  const { hostPath } = JSON.parse(result.stdout);
  return readFile(path.join(hostPath, "index.json"), "utf8").then((text) => JSON.parse(text).entries.map((entry) => entry.author));
};
const overlaps = (left, right, clearance = 0) => left.x < right.x + right.width + clearance && right.x < left.x + left.width + clearance && left.y < right.y + right.height + clearance && right.y < left.y + left.height + clearance;
const SHAPES = new Set(["rectangle", "diamond", "ellipse"]);

// A human's drawing, saved through the API as a CLI writer (the tab only reads it).
const box = (id, x, y, label) => [
  { id, type: "rectangle", x, y, width: 220, height: 110, strokeColor: "#1971c2", backgroundColor: "#a5d8ff", fillStyle: "solid", boundElements: [{ type: "text", id: `${id}-label` }] },
  { id: `${id}-label`, type: "text", x: x + 10, y: y + 42, width: 200, height: 25, text: label, originalText: label, fontSize: 20, fontFamily: 5, textAlign: "center", verticalAlign: "middle", containerId: id },
];
const drawing = () => [...box("idea", 0, 0, "Human idea"), ...box("note", 360, 40, "Human note")];
const FLOW = `flowchart TD
  A["Ingest"] --> B{"Valid?"}
  B -->|yes| C["Store"]
  B -->|no| D["Reject"]
  subgraph S["Sinks"]
    C
    D
  end
`;

const pageErrors = [];
const openTab = async (browser, board) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  const layouts = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  if (process.env.XCLD_DEBUG) page.on("request", (request) => request.method() !== "GET" && console.log("request", request.method(), request.url()));
  page.on("response", async (response) => {
    if (response.request().method() !== "POST" || !response.url().includes("?layout=")) return;
    layouts.push({ status: response.status() });
  });
  await page.goto(`${baseUrl}/?board=${encodeURIComponent(board)}`);
  await page.waitForSelector(".excalidraw__canvas.interactive");
  await page.waitForFunction(() => /Loaded|Saved|Started empty/.test(document.querySelector(".status")?.textContent ?? ""));
  return { context, page, layouts };
};
const shot = async (page, name) => {
  await mkdir(shotsDir, { recursive: true });
  const file = path.join(shotsDir, `${name}.png`);
  await page.screenshot({ path: file });
  return file;
};

const checks = {
  async "hand-drawn"(browser) {
    const board = `sandbox/inbox-merge/${run}-hand`;
    const seeded = await post(`/api/branch/${boardPath(board)}`, { author: "cli:inbox-check", base: null, elements: drawing() });
    assert(seeded.status === "merged", `seed: ${JSON.stringify(seeded)}`);
    const tab = await openTab(browser, board);
    const writtenAt = Date.now() - 4000;
    const written = await post(`/api/mermaid/${boardPath(board)}`, { author: AGENT, writtenAt, mermaid: FLOW });
    assert(written.httpStatus === 202 && written.status === "needs-tab", `write: ${JSON.stringify(written)}`);
    const landed = await waitFor("the tab's layout to land", async () => {
      const current = await status(board, written.pendingId);
      return current.status === "landed" ? current : null;
    });
    assert(landed.via === "tab", `landed via ${landed.via}`);
    await waitFor("the tab's layout answer", () => tab.layouts.length > 0, 10_000);
    assert(tab.layouts.length === 1 && tab.layouts[0].status === 200, `the tab posted one layout: ${JSON.stringify(tab.layouts)}`);
    assert(landed.placement === "below", `placement ${landed.placement}`);
    const master = await waitFor("master with the diagram", async () => {
      const current = await read(board);
      return current?.elements.some((element) => element.id === "A") ? current : null;
    });
    const byId = new Map(master.elements.map((element) => [element.id, element]));
    for (const id of ["idea", "idea-label", "note", "note-label"]) assert(byId.has(id), `${id} kept`);
    const human = ["idea", "note"].map((id) => byId.get(id));
    const added = master.elements.filter((element) => SHAPES.has(element.type) && !["idea", "note"].includes(element.id));
    for (const shape of added) {
      for (const mine of human) assert(!overlaps(shape, mine, 20), `${shape.id} overlaps ${mine.id}`);
      assert(shape.customData?.xcldOrigin?.mermaid?.source === "main", `${shape.id} stamped`);
    }
    // The tab shows the merged board: wait for the reload after the merge, then a screenshot.
    await tab.page.waitForFunction(() => /merged|Laid out Mermaid/.test(document.querySelector(".status")?.textContent ?? ""), null, { timeout: 15_000 }).catch(() => {});
    await delay(800);
    const screenshot = await shot(tab.page, "hand-drawn");
    const statusText = await tab.page.locator(".status").textContent();
    // The next write applies on the server, no tab conversion.
    const next = await post(`/api/mermaid/${boardPath(board)}`, { author: AGENT, base: master.version, mermaid: FLOW.replace('"Store"', '"Archive"') });
    assert(next.httpStatus === 200 && next.ops.some((op) => op.op === "relabel"), `next write: ${JSON.stringify(next)}`);
    await delay(1500);
    assert(tab.layouts.length === 1, "no second tab conversion");
    const authors = await history(board);
    if (authors && !authors.error) assert(authors.includes(AGENT), `history authors ${authors}`);
    await tab.context.close();
    return { board, pendingId: written.pendingId, landed, placement: landed.placement, added: added.map((element) => element.id), humanKept: true, statusText, writtenAt, historyAuthors: authors, screenshot };
  },

  async empty(browser) {
    const board = `sandbox/inbox-merge/${run}-empty`;
    const tab = await openTab(browser, board);
    const written = await post(`/api/mermaid/${boardPath(board)}`, { author: AGENT, mermaid: FLOW });
    assert(written.reason === "new board", `reason ${written.reason}`);
    const landed = await waitFor("landing", async () => {
      const current = await status(board, written.pendingId);
      return current.status === "landed" ? current : null;
    });
    assert(landed.via === "tab", `via ${landed.via}`);
    await waitFor("the tab's layout answer", () => tab.layouts.length > 0, 10_000);
    assert(landed.placement === "keep", `placement ${landed.placement}`);
    await delay(1500);
    const screenshot = await shot(tab.page, "empty");
    await tab.context.close();
    return { board, landed, placement: "keep", screenshot };
  },

  async source(browser) {
    const board = `sandbox/inbox-merge/${run}-source`;
    await post(`/api/branch/${boardPath(board)}`, { author: "cli:inbox-check", base: null, elements: drawing() });
    const tab = await openTab(browser, board);
    const first = await post(`/api/mermaid/${boardPath(board)}`, { author: AGENT, mermaid: FLOW });
    await waitFor("main landing", async () => (await status(board, first.pendingId)).status === "landed");
    const side = await post(`/api/mermaid/${boardPath(board)}`, { author: AGENT, source: "side", mermaid: "flowchart LR\n  A[One] --> B[Two]\n" });
    assert(side.httpStatus === 202 && side.source === "side", `side: ${JSON.stringify(side)}`);
    await waitFor("side landing", async () => (await status(board, side.pendingId)).status === "landed");
    const master = await read(board);
    const ids = master.elements.map((element) => element.id);
    assert(ids.includes("side:A") && ids.includes("side:B") && ids.includes("side:A_B"), `side ids: ${ids}`);
    const rightmost = Math.max(...master.elements.filter((element) => SHAPES.has(element.type) && !element.id.startsWith("side:")).map((element) => element.x + element.width));
    assert(master.elements.find((element) => element.id === "side:A").x > rightmost, "LR goes right of the drawing");
    await delay(1500);
    const screenshot = await shot(tab.page, "source");
    await tab.context.close();
    return { board, ids: ids.filter((id) => id.startsWith("side:")), screenshot };
  },
};

const { chromium } = resolvePlaywright();
const browser = await chromium.launch({ headless: true });
const report = { mode: "headless Chromium (Playwright)", url: baseUrl, run, results: {}, pageErrors };
let failed = false;
try {
  for (const [name, check] of Object.entries(checks)) {
    try {
      report.results[name] = { ok: true, ...(await check(browser)) };
      console.log(`ok   ${name}`);
    } catch (error) {
      failed = true;
      report.results[name] = { ok: false, error: error.message };
      console.log(`FAIL ${name}: ${error.message}`);
    }
  }
} finally {
  await browser.close();
  await mkdir(shotsDir, { recursive: true });
  await writeFile(path.join(shotsDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
console.log(JSON.stringify(report, null, 2));
process.exit(failed ? 1 : 0);
