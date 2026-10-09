// Headless Chromium check of the upgrade path (issue #42): a tab that loaded a build from before
// versions stays open while the server is upgraded. A developer check, not part of
// `node --test tests`; it starts and stops its own Compose project. See README.md in this folder.
//
//   node tests/browser/run-upgrade-tab.mjs --old-tag <tag of an image built before versions, e.g. 0d7330e-...>
//     [--old-image xcld-collab] --new-image <image> --new-tag <tag> [--port 3271] [--project xcld-up]
//     [--container xcld-up] [--dir .scratch/upgrade-tab] [--keep]
//
// 1. Starts the old image on a scratch boards folder and opens the board in a tab; an agent's
//    Mermaid inbox (written as the old `write_mermaid` did) is converted by that tab and replaces
//    the board, unstamped. The tab then draws a shape of its own.
// 2. Upgrades: the same Compose project, same port and folders, with the new image. The old tab
//    stays open (its event stream reconnects).
// 3. An agent writes a named Mermaid source: the old page converts the leftover inbox on the
//    Mermaid event and saves it; the server must refuse it (409 reload-required) and the board
//    must not change. An edit in the old tab must show "Save failed: HTTP 409" and save nothing.
// 4. A reload gets the new page: the pending write lands, the leftover inbox is adopted (no `_2`
//    copies), and the tab saves again.
// Screenshots and report.json go to <dir>/shots. `--keep` leaves the stack up; otherwise it is
// taken down with its volume.
import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
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
const oldImage = option("--old-image", "xcld-collab");
const oldTag = option("--old-tag");
const newImage = option("--new-image");
const newTag = option("--new-tag");
if (!oldTag || !newImage || !newTag) {
  console.error("usage: node tests/browser/run-upgrade-tab.mjs --old-tag <tag> --new-image <image> --new-tag <tag> [--old-image xcld-collab] [--port 3271] [--project xcld-up] [--container xcld-up] [--dir .scratch/upgrade-tab] [--keep]");
  process.exit(2);
}
const port = Number(option("--port", "3271"));
const project = option("--project", "xcld-up");
const container = option("--container", "xcld-up");
const dir = path.resolve(option("--dir", path.join(repoRoot, ".scratch", "upgrade-tab")));
const keep = argv.includes("--keep");
const boardsDir = path.join(dir, "boards");
const shotsDir = path.join(dir, "shots");
const baseUrl = `http://127.0.0.1:${port}`;
const BOARD = "sandbox/upgrade/flow";
const AGENT = "agent:upgrade-check#u1";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (what, check, ms = 30_000) => {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await check();
    } catch {
      last = null;
    }
    if (last) return last;
    await delay(200);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const compose = (image, tag, ...args) => {
  const env = {
    ...process.env,
    XCLD_IMAGE: image,
    XCLD_TAG: tag,
    XCLD_PORT: String(port),
    XCLD_MCP_PORT: String(port + 1),
    XCLD_CONTAINER: container,
    XCLD_MCP_CONTAINER: `${container}-mcp`,
    XCLD_BOARDS: boardsDir,
    XCLD_CACHE_DIR: path.join(dir, "cache"),
    XCLD_AUTHOR_NAME: "Ada",
    XCLD_WATCH_POLL_MS: "300",
  };
  delete env.COMPOSE_PROFILES;
  const result = spawnSync("docker", ["compose", "-p", project, ...args], { cwd: repoRoot, env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`docker compose ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
};
const up = (image, tag) => compose(image, tag, "up", "-d", "--force-recreate", "canvas");
const down = () => compose(newImage, newTag, "down", "-v");
const healthy = () => waitFor("the server", async () => (await fetch(`${baseUrl}/api/boards`)).ok, 90_000);

// Excalidraw's API, from its App component (neither build exposes it): edits through it go
// through the tab's own onChange and autosave, as a human's do.
const HAND_DRAWN = "Hd-7kP2qL9xR4mN8vT1wZ";
const canvasApi = (page) => waitFor("the canvas API", () => page.evaluate(() => {
  const root = document.querySelector(".excalidraw");
  const key = root && Object.keys(root).find((name) => name.startsWith("__reactFiber$"));
  for (let fiber = key ? root[key] : null; fiber; fiber = fiber.return) {
    if (fiber.stateNode?.api?.updateScene) {
      window.__xcldApi = fiber.stateNode.api;
      return true;
    }
  }
  return false;
}));
const drawShape = (page, id, x, y) => page.evaluate(({ id, x, y }) => {
  const api = window.__xcldApi;
  const now = Date.now();
  const shape = { id, type: "rectangle", x, y, width: 160, height: 80, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "#ffec99", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, index: null, roundness: { type: 3 }, seed: 7, version: 1, versionNonce: 7, isDeleted: false, boundElements: null, updated: now, link: null, locked: false };
  api.updateScene({ elements: [...api.getSceneElements(), shape] });
}, { id, x, y });
const moveShape = (page, id, dx) => page.evaluate(({ id, dx }) => {
  const api = window.__xcldApi;
  api.updateScene({ elements: api.getSceneElements().map((element) => (element.id === id ? { ...element, x: element.x + dx, version: element.version + 1, versionNonce: element.versionNonce + 1, updated: Date.now() } : element)) });
}, { id, dx });

const boardPath = (board) => board.split("/").map(encodeURIComponent).join("/");
const readBoard = async () => {
  const response = await fetch(`${baseUrl}/api/board/${boardPath(BOARD)}`);
  return response.ok ? { version: response.headers.get("etag")?.replace(/"/g, "") ?? null, scene: await response.json() } : null;
};
const live = (scene) => (scene?.elements ?? []).filter((element) => !element.isDeleted);
const shapes = (scene) => live(scene).filter((element) => ["rectangle", "diamond", "ellipse"].includes(element.type));
const inContainer = (args) => spawnSync("docker", ["exec", container, ...args], { encoding: "utf8" });

const MAIN = [
  "flowchart TD",
  '  CLIENT["Client"] --> API["API"]',
  '  API --> STORE["Storage"]',
  '  API --> QUEUE["Queue"]',
  "",
].join("\n");
const EXTRA = [
  "flowchart TD",
  '  FCONN["Connection"] --> FTARGET["Target service"]',
  "  linkStyle 0 stroke:#1c7ed6,stroke-width:3px",
  "",
].join("\n");

const report = { startedAt: new Date().toISOString(), headless: true, oldImage: `${oldImage}:${oldTag}`, newImage: `${newImage}:${newTag}`, steps: [] };
const step = (name, data = {}) => {
  report.steps.push({ name, ...data });
  console.log(`- ${name}${Object.keys(data).length ? ` ${JSON.stringify(data)}` : ""}`);
};

await rm(dir, { recursive: true, force: true });
await mkdir(path.join(boardsDir, ...BOARD.split("/").slice(0, -1)), { recursive: true });
await mkdir(path.join(dir, "cache"), { recursive: true });
await mkdir(shotsDir, { recursive: true });
const { chromium } = resolvePlaywright();
const browser = await chromium.launch({ headless: true });
let failed = null;
let shotPage = null;
try {
  // ---- 1. the old build -----------------------------------------------------------------------
  up(oldImage, oldTag);
  await healthy();
  // The old write_mermaid wrote the inbox file; an open tab converted it and replaced the board.
  await writeFile(path.join(boardsDir, ...`${BOARD}.mmd`.split("/")), MAIN, "utf8");
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  shotPage = page;
  // Watch the page's event stream (not changed, only recorded), to report when it reconnects.
  await page.addInitScript(() => {
    const Native = window.EventSource;
    window.__xcldStreams = [];
    window.EventSource = class extends Native {
      constructor(...args) {
        super(...args);
        window.__xcldStreams.push(this);
        this.addEventListener("open", () => { window.__xcldOpened = (window.__xcldOpened ?? 0) + 1; });
      }
    };
  });
  // The page's board saves and their answers, recorded in the page (the request is unchanged).
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    window.__xcldPuts = [];
    window.fetch = async (input, init = {}) => {
      const response = await nativeFetch(input, init);
      const url = String(typeof input === "string" ? input : input?.url ?? input);
      if (String(init?.method ?? "GET").toUpperCase() === "PUT" && url.includes("/api/board/")) {
        const headers = [...new Headers(init.headers ?? {}).keys()].filter((key) => key.startsWith("x-xcld") || key === "if-match").sort();
        window.__xcldPuts.push({ status: response.status, headers, body: await response.clone().text().catch(() => "") });
      }
      return response;
    };
  });
  const putsOf = () => page.evaluate(() => window.__xcldPuts ?? []);
  const nextPut = (after, what, ms) => waitFor(what, async () => {
    const list = await putsOf();
    return list.length > after ? list[after] : null;
  }, ms);
  const consoleErrors = [];
  report.consoleErrors = consoleErrors;
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) consoleErrors.push(`+${Date.now()} ${message.text()}`);
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  await page.goto(`${baseUrl}/?board=${encodeURIComponent(BOARD)}`);
  await page.waitForSelector(".excalidraw__canvas.interactive");
  const converted = await waitFor("the old tab's conversion", async () => {
    const board = await readBoard();
    return board && shapes(board.scene).length >= 4 ? board : null;
  });
  assert(!shapes(converted.scene).some((element) => element.customData?.xcldOrigin || element.customData?.xcldMermaidHash), "the old build's conversion is unstamped");
  step("old build: the tab converted the inbox and replaced the board", { shapes: shapes(converted.scene).map((element) => element.id).sort(), put: (await putsOf()).at(-1)?.status, identityHeaders: (await putsOf()).at(-1)?.headers ?? [] });
  // The human draws a shape of their own (Excalidraw ids are nanoids; this one has a "-").
  await canvasApi(page);
  await drawShape(page, HAND_DRAWN, -400, 0);
  const drawn = await waitFor("the old tab's save of the drawn shape", async () => {
    const board = await readBoard();
    const own = shapes(board?.scene).filter((element) => !["CLIENT", "API", "STORE", "QUEUE"].includes(element.id));
    return own.length ? { board, id: own[0].id } : null;
  });
  step("old build: the human drew a shape", { id: drawn.id });
  await page.screenshot({ path: path.join(shotsDir, "1-old-build.png") });

  // ---- 2. the upgrade (the tab stays open) ------------------------------------------------------
  up(newImage, newTag);
  await healthy();
  const upgraded = await readBoard();
  step("upgraded: the new server is up, the old tab is still open", { version: upgraded.version.slice(0, 12), shapes: shapes(upgraded.scene).length });
  // The page's event stream reconnects by itself (the browser retries a dropped stream).
  const opensBefore = await page.evaluate(() => window.__xcldOpened ?? 0);
  const reconnected = await waitFor("the old tab's event stream to reconnect", () => page.evaluate((before) => (window.__xcldOpened ?? 0) > before && window.__xcldStreams.some((stream) => stream.readyState === 1), opensBefore).catch(() => false), 60_000).catch(() => false);
  step("old tab: event stream after the upgrade", { reconnected, states: await page.evaluate(() => window.__xcldStreams.map((stream) => stream.readyState)) });

  // ---- 3. an agent writes a named source; the old tab reacts to the Mermaid event ---------------
  const putsBefore = (await putsOf()).length;
  const written = await (await fetch(`${baseUrl}/api/mermaid/${boardPath(BOARD)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ author: AGENT, source: "extra", base: upgraded.version, position: `near:${drawn.id}`, mermaid: EXTRA }),
  })).json();
  step("agent: write_mermaid source=extra", { status: written.status, reason: written.reason });
  const refused = await nextPut(putsBefore, "the old tab's save after the Mermaid event", 20_000);
  const afterEvent = await readBoard();
  assert(refused.status === 409 && /reload-required/.test(refused.body), `the old tab's save was refused: ${JSON.stringify(refused)}`);
  assert(afterEvent.version === upgraded.version, "the board didn't change");
  step("old tab: converted the leftover inbox and saved it -> refused", { status: refused.status, body: JSON.parse(refused.body).error, boardUnchanged: afterEvent.version === upgraded.version });

  // An edit in the old tab: its autosave is refused and the status bar says so.
  const editPuts = (await putsOf()).length;
  await moveShape(page, HAND_DRAWN, 40);
  const statusText = await waitFor("the old tab's error", async () => {
    const text = await page.locator(".status").textContent();
    return /Save failed: HTTP 409/.test(text ?? "") ? text : null;
  });
  await page.screenshot({ path: path.join(shotsDir, "2-old-tab-refused.png") });
  const afterEdit = await readBoard();
  const editSaves = (await putsOf()).slice(editPuts);
  assert(editSaves.length > 0 && editSaves.every((put) => put.status === 409), "every old-tab save was refused");
  assert(afterEdit.version === upgraded.version, "the board still didn't change");
  const history = inContainer(["xcld", "history", "export", BOARD, "--json"]);
  const legacyEntries = (history.stdout.match(/#legacy/g) ?? []).length;
  assert(legacyEntries === 0, "no #legacy entry in history");
  step("old tab: an edit shows the error, nothing saved", { status: statusText.trim(), refusedSaves: editSaves.length, legacyHistoryEntries: legacyEntries });

  // ---- 4. reload: the new page --------------------------------------------------------------
  await page.reload();
  await page.waitForSelector("[data-testid=author-overlay] button");
  const landed = await waitFor("the extra write to land and the board to settle", async () => {
    const board = await readBoard();
    return shapes(board?.scene).some((element) => element.id === "extra:FCONN") ? board : null;
  });
  const ids = live(landed.scene).map((element) => element.id);
  const copies = ids.filter((id) => /_2(_label)?$/.test(id));
  const adopted = shapes(landed.scene).filter((element) => element.customData?.xcldOrigin?.mermaid?.source === "main").map((element) => element.id).sort();
  const arrow = live(landed.scene).find((element) => element.id === "extra:FCONN_FTARGET");
  assert(copies.length === 0, `no _2 copies: ${copies}`);
  assert(ids.includes(drawn.id), "the drawn shape is kept");
  assert(JSON.stringify(adopted) === JSON.stringify(["API", "CLIENT", "QUEUE", "STORE"]), `the old conversion adopted as main: ${adopted}`);
  assert(arrow?.strokeColor === "#1c7ed6" && arrow?.strokeWidth === 3, `linkStyle on the tab's layout: ${arrow?.strokeColor} ${arrow?.strokeWidth}`);
  await canvasApi(page);
  await drawShape(page, "Nw-after-reload-0000x", -400, 300);
  const saved = await waitFor("the new page's save", async () => (await putsOf()).find((put) => put.status === 200));
  await page.screenshot({ path: path.join(shotsDir, "3-reloaded.png") });
  step("reloaded: new page; pending write landed, inbox adopted, saves work", { copies: copies.length, adopted, drawnKept: true, extraArrow: [arrow.strokeColor, arrow.strokeWidth], save: saved.status, identityHeaders: saved.headers, status: (await page.locator(".status").textContent())?.trim() });
  report.ok = true;
} catch (error) {
  failed = error;
  report.ok = false;
  report.error = error.message;
  await shotPage?.screenshot({ path: path.join(shotsDir, "failure.png") }).catch(() => {});
} finally {
  await browser.close();
  await writeFile(path.join(shotsDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (!keep) {
    try {
      down();
    } catch (error) {
      console.warn(error.message);
    }
  }
}
if (failed) {
  console.error(`FAILED: ${failed.message}`);
  process.exit(1);
}
console.log(`upgrade-tab check passed (headless Chromium); report in ${path.join(shotsDir, "report.json")}`);
