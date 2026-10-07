// Headless Chromium checks of the canvas tab (versions and merge, slice 5), against a running
// canvas. These are developer checks, not the lead's acceptance test, and not part of
// `node --test tests`. See README.md in this folder.
//
//   node tests/browser/run-tab-checks.mjs --url http://127.0.0.1:3221 [--shots <dir>]
//     [--container <canvas container>] [--only <check>[,<check>]]
//
// Boards go under sandbox/tab-checks/<run>-<check>. Agent writes go through POST /api/branch,
// as `agent:tab-checks#c0ffee`. With --container, history entries are read with
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
  console.error("usage: node tests/browser/run-tab-checks.mjs --url http://127.0.0.1:<port> [--shots <dir>] [--container <name>] [--only <check>]");
  process.exit(2);
}
const shotsDir = path.resolve(option("--shots", path.join(repoRoot, ".scratch", "tab-checks")));
const container = option("--container");
const only = option("--only")?.split(",") ?? null;
const run = Date.now().toString(36);
const AGENT = "agent:tab-checks#c0ffee";
const DRAG = 150;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (what, check, ms = 15_000) => {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await delay(100);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

// --- the server -------------------------------------------------------------------------------
const boardPath = (board) => board.split("/").map(encodeURIComponent).join("/");
const read = async (board) => {
  const response = await fetch(`${baseUrl}/api/board/${boardPath(board)}`);
  assert(response.ok, `GET ${board}: HTTP ${response.status}`);
  return { version: response.headers.get("etag").replaceAll("\"", ""), elements: (await response.json()).elements };
};
const post = async (board, body) => {
  const response = await fetch(`${baseUrl}/api/branch/${boardPath(board)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  assert(response.ok && result.status === "merged", `POST ${board}: ${response.status} ${JSON.stringify(result)}`);
  return result;
};
const seed = (board, elements) => post(board, { author: "cli:tab-checks", base: null, elements });
// An agent's write: `change` maps the elements it read; `base` defaults to what it read.
const agentWrite = async (board, change, { base, writtenAt } = {}) => {
  const current = await read(board);
  const from = base ? { version: base.version, elements: base.elements } : current;
  return post(board, { author: AGENT, base: from.version, elements: change(structuredClone(from.elements)), ...(writtenAt ? { writtenAt } : {}) });
};
const byId = (elements) => new Map(elements.map((element) => [element.id, element]));
const textOf = (elements, id) => byId(elements).get(id)?.text;

// SSE `merged` events, as every tab sees them.
const merged = [];
const sse = new AbortController();
const listen = async () => {
  const response = await fetch(`${baseUrl}/api/events`, { signal: sse.signal });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
      const chunk = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (/^event: merged$/m.test(chunk)) merged.push({ at: Date.now(), ...JSON.parse(/^data: (.*)$/m.exec(chunk)[1]) });
    }
  }
};

// Minimal JSON, as an agent writes it: the canvas fills in the rest (restore).
const box = (id, x, y, label) => [
  { id, type: "rectangle", x, y, width: 200, height: 120, strokeColor: "#1971c2", backgroundColor: "#a5d8ff", fillStyle: "solid", boundElements: [{ type: "text", id: `${id}-label` }] },
  { id: `${id}-label`, type: "text", x: x + 10, y: y + 47, width: 180, height: 25, text: label, originalText: label, fontSize: 20, fontFamily: 5, textAlign: "center", verticalAlign: "middle", containerId: id },
];
// Content box 0..600 x 0..420; the tab opens centered on it at zoom 1.
const layout = () => [...box("a", 0, 0, "Drag me"), ...box("b", 400, 0, "API"), ...box("c", 0, 300, "Agent target"), ...box("e", 400, 300, "Hello")];
const CONTENT_CENTER = { x: 300, y: 210 };

// The board's history entries (index.json), with each entry's overwritten units from its meta.
const history = async (board) => {
  if (!container) return null;
  const result = spawnSync("docker", ["exec", container, "xcld", "history", "export", board, "--json"], { encoding: "utf8" });
  if (result.status !== 0) return { error: result.stderr.trim() };
  const { hostPath } = JSON.parse(result.stdout);
  const index = JSON.parse(await readFile(path.join(hostPath, "index.json"), "utf8"));
  return Promise.all(index.entries.map(async (entry) => {
    const meta = JSON.parse(await readFile(path.join(hostPath, `${entry.entry}.meta.json`), "utf8"));
    return {
      author: entry.author,
      closedBy: entry.closedBy ?? null,
      coalescedCount: entry.coalescedCount,
      overwritten: (meta.overwritten ?? []).map((unit) => ({ label: unit.label, winner: unit.winner.author, loser: unit.loser.author, loserElements: unit.loser.elements?.length ?? 0 })),
    };
  }));
};

// --- the browser ------------------------------------------------------------------------------
const pageErrors = [];
const openTab = async (context, board, label) => {
  const page = await context.newPage();
  const tab = { page, label, puts: [], answers: [], checkpoints: [], downloads: 0 };
  page.on("pageerror", (error) => pageErrors.push(`${label}: ${error.message}`));
  page.on("download", () => tab.downloads++);
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().includes("/api/board/")) tab.puts.push(request.headers());
  });
  page.on("response", async (response) => {
    if (response.request().method() === "POST" && response.url().endsWith("/checkpoint")) tab.checkpoints.push(await response.json().catch(() => null));
    if (response.request().method() === "PUT" && response.url().includes("/api/board/")) {
      const answer = await response.json().catch(() => null);
      tab.answers.push({ status: response.status(), merged: answer?.merged ?? null, applied: answer?.applied?.length ?? null, overwritten: answer?.overwritten?.length ?? null });
    }
  });
  await page.goto(`${baseUrl}/?board=${encodeURIComponent(board)}`);
  await page.waitForSelector(".excalidraw__canvas.interactive");
  await page.waitForFunction(() => /Loaded|Saved/.test(document.querySelector(".status")?.textContent ?? ""));
  await page.waitForSelector("[data-testid=author-overlay] button");
  return tab;
};
const toScreen = async (page, point) => {
  const canvas = await page.locator(".excalidraw__canvas.interactive").boundingBox();
  return { x: canvas.x + canvas.width / 2 + (point.x - CONTENT_CENTER.x), y: canvas.y + canvas.height / 2 + (point.y - CONTENT_CENTER.y) };
};
const centerOf = (id) => ({ a: { x: 100, y: 60 }, b: { x: 500, y: 60 }, c: { x: 100, y: 360 }, e: { x: 500, y: 360 } })[id];
const status = (page) => page.locator(".status").textContent();
const banner = (page) => page.locator("[data-testid=merge-banner]");
const authorButton = (page) => page.locator("[data-testid=author-overlay] button");
const shot = async (page, name) => {
  const file = path.join(shotsDir, `${name}.png`);
  await page.screenshot({ path: file });
  return file;
};
const savedAfter = (tab, count) => waitFor(`a save from ${tab.label}`, () => tab.puts.length > count);
const settle = () => delay(1800);
const headerOf = (headers) => ({ name: decodeURIComponent(headers["x-xcld-author-name"] ?? ""), tab: headers["x-xcld-tab"], editAge: headers["x-xcld-edit-age"] ?? null });

// --- checks -----------------------------------------------------------------------------------
const checks = {
  // An agent writes while the human is mid-drag: the drag isn't lost, the agent's change lands,
  // and the banner names the agent.
  async "mid-drag"(browser) {
    const board = `sandbox/tab-checks/${run}-mid-drag`;
    await seed(board, layout());
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const tab = await openTab(context, board, "drag");
    const { page } = tab;
    const start = await toScreen(page, centerOf("a"));
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (let step = 1; step <= 10; step++) await page.mouse.move(start.x + (DRAG / 2) * (step / 10), start.y, { steps: 2 });
    const puts = tab.puts.length;
    const agent = await agentWrite(board, (elements) => [
      ...elements.map((element) => (element.id === "c-label" ? { ...element, text: "Agent changed", originalText: "Agent changed" } : element)),
      ...box("d", 800, 300, "Agent added"),
    ]);
    // Save before reload: the tab flushes the half-done drag while the mouse is still down.
    await savedAfter(tab, puts);
    await waitFor("the flush's answer", () => tab.answers.length > puts);
    await delay(400);
    const midDrag = { flush: { ...headerOf(tab.puts[puts]), ...tab.answers[puts] }, bannerWhileDragging: await banner(page).isVisible() };
    assert(midDrag.flush.merged === true, `the flush merged: ${JSON.stringify(midDrag)}`);
    assert(midDrag.bannerWhileDragging, "the banner shows while the mouse is still down");
    const midShot = await shot(page, "mid-drag-while-dragging");
    for (let step = 1; step <= 10; step++) await page.mouse.move(start.x + DRAG / 2 + (DRAG / 2) * (step / 10), start.y, { steps: 2 });
    await page.mouse.up();
    await settle();
    const final = await waitFor("the finished drag on master", async () => {
      const board_ = await read(board);
      return Math.abs(byId(board_.elements).get("a").x - DRAG) <= 4 ? board_ : null;
    });
    const a = byId(final.elements).get("a");
    assert(textOf(final.elements, "c-label") === "Agent changed", "the agent's relabel is on master");
    assert(byId(final.elements).has("d"), "the agent's new shape is on master");
    await waitFor("the banner", () => banner(page).isVisible());
    const bannerText = await banner(page).textContent();
    assert(/tab-checks \(agent\): 1 added, 1 changed/.test(bannerText), `banner: ${bannerText}`);
    const file = await shot(page, "mid-drag-banner");
    await context.close();
    return { board, agentVersion: agent.version, midDrag, aX: a.x, cLabel: textOf(final.elements, "c-label"), bannerText, saves: tab.puts.map(headerOf), answers: tab.answers, screenshots: [midShot, file] };
  },

  // An agent writes while the human is typing a label: every typed character lands.
  async "mid-typing"(browser) {
    const board = `sandbox/tab-checks/${run}-mid-typing`;
    await seed(board, layout());
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const tab = await openTab(context, board, "typing");
    const { page } = tab;
    const target = await toScreen(page, centerOf("e"));
    await page.mouse.dblclick(target.x, target.y);
    await page.waitForSelector("textarea.excalidraw-wysiwyg");
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type("Typed while", { delay: 80 });
    await delay(300);
    const puts = tab.puts.length;
    await agentWrite(board, (elements) => [
      ...elements.map((element) => (element.id === "b-label" ? { ...element, text: "API (agent)", originalText: "API (agent)" } : element)),
      ...box("f", 800, 0, "Agent added"),
    ]);
    await savedAfter(tab, puts);
    await waitFor("the flush's answer", () => tab.answers.length > puts);
    const flush = { ...headerOf(tab.puts[puts]), ...tab.answers[puts] };
    assert(flush.merged === true, `the flush merged: ${JSON.stringify(flush)}`);
    await page.keyboard.type(" an agent wrote", { delay: 80 });
    await page.keyboard.press("Escape");
    await settle();
    const final = await waitFor("the typed label on master", async () => {
      const board_ = await read(board);
      return byId(board_.elements).get("e-label").originalText === "Typed while an agent wrote" ? board_ : null;
    });
    assert(textOf(final.elements, "b-label") === "API (agent)", "the agent's relabel is on master");
    assert(byId(final.elements).has("f"), "the agent's new shape is on master");
    await waitFor("the banner", () => banner(page).isVisible());
    const bannerText = await banner(page).textContent();
    const file = await shot(page, "mid-typing-banner");
    await context.close();
    return { board, flush, label: byId(final.elements).get("e-label").originalText, bannerText, saves: tab.puts.map(headerOf), screenshot: file };
  },

  // D6: two tabs with the same name both save and both land, with distinct tab ids.
  async "d6-two-tabs"(browser) {
    const board = `sandbox/tab-checks/${run}-d6`;
    await seed(board, layout());
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const first = await openTab(context, board, "tab 1");
    const second = await openTab(context, board, "tab 2");
    const names = [await authorButton(first.page).textContent(), await authorButton(second.page).textContent()];
    assert(names[0] === names[1], `both tabs show one name: ${names}`);
    const draw = async (tab, at) => {
      await tab.page.bringToFront();
      await tab.page.locator("[data-testid=toolbar-rectangle]").click();
      const from = await toScreen(tab.page, at);
      await tab.page.mouse.move(from.x, from.y);
      await tab.page.mouse.down();
      await tab.page.mouse.move(from.x + 120, from.y + 80, { steps: 8 });
      await tab.page.mouse.up();
    };
    const before = merged.length;
    // Both draw before either autosave fires.
    await draw(first, { x: 700, y: 0 });
    await draw(second, { x: 700, y: 250 });
    await settle();
    await delay(1500);
    const files = [await shot(first.page, "d6-tab1"), await shot(second.page, "d6-tab2")];
    const final = await read(board);
    const added = final.elements.filter((element) => element.type === "rectangle" && !["a", "b", "c", "e"].includes(element.id));
    assert(added.length === 2, `both new rectangles landed (found ${added.length})`);
    const keys = [...new Set(merged.slice(before).map((event) => event.author))];
    const headers = [first, second].map((tab) => headerOf(tab.puts.at(-1)));
    assert(headers[0].name === headers[1].name, "same author name");
    assert(headers[0].tab && headers[1].tab && headers[0].tab !== headers[1].tab, `distinct tab ids: ${headers[0].tab} ${headers[1].tab}`);
    const expected = headers.map((header) => `human:${header.name}#${header.tab}`);
    assert(expected.every((key) => keys.includes(key)), `merged events from both keys: ${keys}`);
    const banners = [await banner(first.page).textContent().catch(() => ""), await banner(second.page).textContent().catch(() => "")];
    await context.close();
    return { board, names, headers, mergedAuthors: keys, rectanglesAdded: added.length, banners, history: await history(board), screenshots: files };
  },

  // The overwritten banner: an agent's newer edit beats the human's drag (and the drag never comes
  // back), and an agent's older edit loses to the human's (a write that lost every change).
  async "overwritten"(browser) {
    const board = `sandbox/tab-checks/${run}-overwritten`;
    await seed(board, layout());
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const tab = await openTab(context, board, "overwritten");
    const { page } = tab;
    const stale = await read(board);
    const drag = async (id, dx) => {
      const from = await toScreen(page, centerOf(id));
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + dx, from.y, { steps: 10 });
      await page.mouse.up();
    };
    // The human moves b and c; both saves land.
    await drag("b", 80);
    await drag("c", 80);
    await settle();
    await waitFor("both drags on master", async () => {
      const current = byId((await read(board)).elements);
      return Math.abs(current.get("b").x - 480) <= 4 && Math.abs(current.get("c").x - 80) <= 4;
    });
    // From the old version, an agent relabels b now (newer: it wins the unit, the drag is
    // overwritten) and relabels c with a write time a minute ago (older: it loses everything).
    const winner = await agentWrite(board, (elements) => elements.map((element) => (element.id === "b-label" ? { ...element, text: "API v2", originalText: "API v2" } : element)), { base: stale });
    const loser = await agentWrite(board, (elements) => elements.map((element) => (element.id === "c-label" ? { ...element, text: "Old idea", originalText: "Old idea" } : element)), { base: stale, writtenAt: Date.now() - 60_000 });
    assert(winner.overwritten.length === 1 && loser.overwritten.length === 1 && loser.applied.length === 0, `agent answers: ${JSON.stringify([winner.overwritten, loser])}`);
    await waitFor("the banner", () => banner(page).isVisible());
    await waitFor("both overwritten units on the banner", async () => /2 overwritten edits \(1 of yours\)/.test(await banner(page).textContent()));
    await page.getByRole("button", { name: "details" }).click();
    const details = await page.locator("[data-testid=merge-banner-details] li").allTextContents();
    assert(details.some((line) => /"API v2": your edit was overwritten by tab-checks \(agent\)'s newer edit\. Yours is kept in version history\./.test(line)), `details: ${details}`);
    assert(details.some((line) => /"Agent target": your newer edit overwrote tab-checks \(agent\)'s\. Theirs is kept in version history\./.test(line)), `details: ${details}`);
    const file = await shot(page, "overwritten-banner-details");
    // The tab's next edit doesn't bring its losing drag of b back.
    const puts = tab.puts.length;
    await drag("a", 40);
    await savedAfter(tab, puts);
    await settle();
    const final = byId((await read(board)).elements);
    assert(final.get("b").x === 400 && final.get("b-label").text === "API v2", `b is the agent's: x=${final.get("b").x} ${final.get("b-label").text}`);
    assert(Math.abs(final.get("c").x - 80) <= 4 && final.get("c-label").text === "Agent target", "c is the human's");
    const bannerText = await banner(page).textContent();
    await context.close();
    const entries = await history(board);
    if (entries) {
      assert(entries.some((entry) => entry.overwritten.some((unit) => unit.label === "API v2" && unit.loser.startsWith("human:") && unit.loserElements > 0)), `the losing drag is kept in history: ${JSON.stringify(entries)}`);
    }
    return {
      board,
      bannerText,
      details,
      masterB: { x: final.get("b").x, label: final.get("b-label").text },
      masterC: { x: final.get("c").x, label: final.get("c-label").text },
      history: entries,
      screenshot: file,
    };
  },

  // Ctrl+S closes the human's open history entry, once, and never downloads a file.
  async "ctrl-s"(browser) {
    const board = `sandbox/tab-checks/${run}-ctrl-s`;
    await seed(board, layout());
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true });
    const tab = await openTab(context, board, "ctrl-s");
    const { page } = tab;
    const from = await toScreen(page, centerOf("a"));
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 60, from.y + 20, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.press("Control+S");
    await waitFor("the checkpoint status", async () => (await status(page)) === "Saved checkpoint");
    const file = await shot(page, "ctrl-s-checkpoint");
    await page.keyboard.press("Control+S");
    await waitFor("the second checkpoint answer", () => tab.checkpoints.length >= 2);
    const second = await status(page);
    await delay(500);
    assert(tab.checkpoints[0]?.closed === true && tab.checkpoints[1]?.closed === false, `checkpoint answers ${JSON.stringify(tab.checkpoints)}`);
    assert(second === "No changes since the last checkpoint", second);
    assert(tab.downloads === 0, "no download");
    const master = byId((await read(board)).elements).get("a");
    await context.close();
    const entries = await history(board);
    if (entries) {
      assert(entries.some((entry) => entry.author.startsWith("human:") && entry.closedBy === "checkpoint"), `history: ${JSON.stringify(entries)}`);
    }
    return { board, answers: tab.checkpoints, statusAfterSecond: second, downloads: tab.downloads, aMoved: { x: master.x, y: master.y }, history: entries, screenshot: file };
  },

  // A rename is remembered across a reload (and shared by the browser's other tabs); the tab id
  // stays the same across the reload.
  async "rename"(browser) {
    const board = `sandbox/tab-checks/${run}-rename`;
    await seed(board, layout());
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const tab = await openTab(context, board, "rename");
    const { page } = tab;
    const before = await authorButton(page).textContent();
    await authorButton(page).click();
    await page.locator("#xcld-author-name").fill("Renamed Tester");
    await page.keyboard.press("Enter");
    await waitFor("the new name", async () => (await authorButton(page).textContent()) === "Author: Renamed Tester");
    const edit = async () => {
      const puts = tab.puts.length;
      const from = await toScreen(page, centerOf("a"));
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + 30, from.y, { steps: 5 });
      await page.mouse.up();
      await savedAfter(tab, puts);
      return headerOf(tab.puts.at(-1));
    };
    const beforeReload = await edit();
    await page.reload();
    await page.waitForFunction(() => /Loaded|Saved/.test(document.querySelector(".status")?.textContent ?? ""));
    const afterReloadName = await authorButton(page).textContent();
    await settle();
    const afterReload = await edit();
    const other = await openTab(context, board, "rename, second tab");
    const otherName = await authorButton(other.page).textContent();
    assert(afterReloadName === "Author: Renamed Tester", afterReloadName);
    assert(beforeReload.name === "Renamed Tester" && afterReload.name === "Renamed Tester", JSON.stringify([beforeReload, afterReload]));
    assert(beforeReload.tab === afterReload.tab, "the tab id survives the reload");
    assert(otherName === "Author: Renamed Tester", `the browser's other tab: ${otherName}`);
    const file = await shot(page, "rename-after-reload");
    await context.close();
    return { board, before, afterReloadName, otherTab: otherName, beforeReload, afterReload, screenshot: file };
  },
};

const main = async () => {
  await mkdir(shotsDir, { recursive: true });
  void listen().catch(() => {});
  const { chromium } = resolvePlaywright();
  const browser = await chromium.launch({ headless: true });
  const results = {};
  let failed = 0;
  try {
    for (const [name, check] of Object.entries(checks)) {
      if (only && !only.includes(name)) continue;
      const started = Date.now();
      try {
        results[name] = { ok: true, ms: 0, ...(await check(browser)) };
      } catch (error) {
        failed++;
        results[name] = { ok: false, error: error.message };
      }
      results[name].ms = Date.now() - started;
      console.error(`${results[name].ok ? "PASS" : "FAIL"} ${name} (${results[name].ms} ms)${results[name].ok ? "" : `: ${results[name].error}`}`);
    }
  } finally {
    await browser.close();
    sse.abort();
  }
  const report = { headless: true, note: "headless Chromium developer checks, not the acceptance test", url: baseUrl, run, results, pageErrors };
  await writeFile(path.join(shotsDir, `report-${run}.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  process.exit(failed ? 1 : 0);
};

await main();
