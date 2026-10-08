// Headless Chromium check: arrow and line styles edited in the canvas tab survive autosave, a
// reload, and agent writes landing during and after the edit (a JSON write of an unrelated shape,
// and a Mermaid write relabelling an unrelated node). A developer check against a running canvas,
// not part of `node --test tests`. See README.md in this folder.
//
//   node tests/browser/run-edge-styles.mjs --url http://127.0.0.1:<port> [--shots <dir>]
//     [--only <scenario>[,<scenario>]] [--json]
//
// Each scenario gets its own board under sandbox/edge-styles/<run>-<scenario>, seeded by an agent's
// Mermaid write that the tab lays out. The human's edits go through Excalidraw's own properties
// panel (stroke style, width, colour, arrow type, arrowheads); only the selection is set through
// the canvas API. Agent writes go through the HTTP API as `agent:edge-styles#e5e5e5`:
//   json     the agent re-sends the whole board it read (bookkeeping stripped, as an LLM does)
//            plus one new rectangle;
//   mermaid  the agent reads the board as Mermaid (to-mermaid, as read_board does), relabels the
//            unrelated node and writes it back (write_mermaid).
// "during" agents read before the human's edits and write between two groups of edits, before the
// autosave; "after" agents read and write once the edits are saved.
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sceneToMermaid } from "../../tools/to-mermaid.mjs";

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
  console.error("usage: node tests/browser/run-edge-styles.mjs --url http://127.0.0.1:<port> [--shots <dir>] [--only <scenario>]");
  process.exit(2);
}
const shotsDir = path.resolve(option("--shots", path.join(repoRoot, ".scratch", "edge-styles")));
const only = option("--only")?.split(",") ?? null;
const run = Date.now().toString(36);
const AGENT = "agent:edge-styles#e5e5e5";
const STYLE_KEYS = ["strokeStyle", "strokeWidth", "strokeColor", "roundness", "elbowed", "startArrowhead", "endArrowhead"];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (what, check, ms = 20_000) => {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await delay(150);
  }
  throw new Error(`timed out waiting for ${what}`);
};

// --- the server -------------------------------------------------------------------------------
const boardPath = (board) => board.split("/").map(encodeURIComponent).join("/");
const read = async (board) => {
  const response = await fetch(`${baseUrl}/api/board/${boardPath(board)}`);
  if (!response.ok) throw new Error(`GET ${board}: HTTP ${response.status}`);
  return { version: response.headers.get("etag").replaceAll("\"", ""), scene: await response.json() };
};
const postJson = async (url, body) => {
  const response = await fetch(`${baseUrl}${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) };
};

// Nine independent pairs (one arrow each, one per human edit) and a node only agents touch.
const PAIRS = ["dashed", "dotted", "straight", "elbow", "noheads_dashed", "thick_dashed", "red_thin", "triangle", "both_heads"];
const DIAGRAM = [
  "flowchart LR",
  ...PAIRS.map((name, index) => `  s${index}["${name} from"] --> t${index}["${name} to"]`),
  "  z[\"Unrelated\"]",
].join("\n");
const arrowIdOf = (index) => `s${index}_t${index}`;

const agentJsonWrite = async (board, from, label) => {
  const elements = structuredClone(from.scene.elements).filter((element) => !element.isDeleted);
  for (const element of elements) {
    for (const key of ["seed", "index", "created", "updated", "version", "versionNonce"]) delete element[key];
  }
  elements.push({ id: `agent-box-${label}`, type: "rectangle", x: 600, y: 600 + Math.random() * 200, width: 120, height: 60, strokeColor: "#1971c2", backgroundColor: "transparent" });
  return postJson(`/api/branch/${boardPath(board)}`, { author: AGENT, base: from.version, kind: "json", elements, appState: from.scene.appState, files: from.scene.files });
};
const agentMermaidWrite = async (board, from, label) => {
  const mermaid = sceneToMermaid(from.scene).replace(/z\["[^"]*"\]/, `z["Unrelated ${label}"]`);
  return { ...(await postJson(`/api/mermaid/${boardPath(board)}`, { author: AGENT, base: from.version, mermaid })), mermaid };
};

// --- the browser ------------------------------------------------------------------------------
const pageErrors = [];
const openTab = async (context, board) => {
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${baseUrl}/?board=${encodeURIComponent(board)}`);
  await page.waitForSelector(".excalidraw__canvas.interactive");
  await page.waitForFunction(() => /Loaded|Saved/.test(document.querySelector(".status")?.textContent ?? ""));
  // The canvas API, from Excalidraw's App component (the tab doesn't expose it).
  await waitFor("the canvas API", () => page.evaluate(() => {
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
  return page;
};
const sceneOf = (page) => page.evaluate(() => window.__xcldApi.getSceneElements().map((element) => ({ ...element })));
const styleOf = (element) => Object.fromEntries(STYLE_KEYS.map((key) => [key, element?.[key] ?? null]));
const select = async (page, id) => {
  await page.evaluate((elementId) => window.__xcldApi.updateScene({ appState: { selectedElementIds: { [elementId]: true }, selectedLinearElement: null } }), id);
  await page.waitForSelector('[aria-label="arrowhead_end"], [title="Dashed"]');
};
const panel = (page) => page.locator(".App-menu__left");
const click = async (page, selector) => {
  // Radio inputs sit under their icon (it takes the pointer): click where they are anyway.
  await panel(page).locator(selector).first().click({ force: true });
  await delay(120);
};
const arrowhead = async (page, end, name) => {
  await click(page, `[aria-label="arrowhead_${end}"]`);
  await page.locator(`button[title^="${name} —"], button[aria-label^="${name}"]`).first().click();
  await delay(120);
};

// The human's edits, each through the properties panel. Returns what the tab shows afterwards.
const EDITS = {
  dashed: (page) => click(page, '[title="Dashed"]'),
  dotted: (page) => click(page, '[title="Dotted"]'),
  straight: (page) => click(page, '[data-testid="sharp-arrow"]'),
  elbow: (page) => click(page, '[data-testid="elbow-arrow"]'),
  noheads_dashed: async (page) => { await arrowhead(page, "end", "None"); await click(page, '[title="Dashed"]'); },
  thick_dashed: async (page) => { await click(page, '[data-testid="strokeWidth-bold"]'); await click(page, '[title="Dashed"]'); },
  red_thin: async (page) => { await click(page, '[data-testid="color-top-pick-#e03131"]'); await click(page, '[data-testid="strokeWidth-thin"]'); },
  triangle: (page) => arrowhead(page, "end", "Triangle"),
  both_heads: (page) => arrowhead(page, "start", "Arrow"),
};
const edit = async (page, name) => {
  const id = arrowIdOf(PAIRS.indexOf(name));
  await select(page, id);
  await EDITS[name](page);
  await page.keyboard.press("Escape");
  return styleOf((await sceneOf(page)).find((element) => element.id === id));
};
// A hand-drawn line, then dashed, extra bold and green.
const drawLine = async (page) => {
  const before = new Set((await sceneOf(page)).map((element) => element.id));
  await page.locator('[data-testid="toolbar-line"]').click();
  const canvas = await page.locator(".excalidraw__canvas.interactive").boundingBox();
  const from = { x: canvas.x + canvas.width - 260, y: canvas.y + canvas.height - 140 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 160, from.y + 40, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.press("Escape");
  const line = (await sceneOf(page)).find((element) => element.type === "line" && !before.has(element.id));
  if (!line) throw new Error("the line tool drew nothing");
  await select(page, line.id);
  await click(page, '[title="Dashed"]');
  await click(page, '[data-testid="strokeWidth-bold"]');
  await click(page, '[data-testid="color-top-pick-#2f9e44"]');
  await page.keyboard.press("Escape");
  return { id: line.id, style: styleOf((await sceneOf(page)).find((element) => element.id === line.id)) };
};

const settled = async (page, board, want) => waitFor("the edits on master", async () => {
  const status = await page.locator(".status").textContent();
  if (!/Saved|Merged/.test(status ?? "")) return null;
  const master = await read(board);
  return Object.entries(want).every(([id, style]) => {
    const element = master.scene.elements.find((item) => item.id === id);
    return element && compare(style, styleOf(element)).length === 0;
  }) ? master : null;
}, 8000).catch(async () => read(board));

const compare = (want, got) => STYLE_KEYS.filter((key) => JSON.stringify(want[key] ?? null) !== JSON.stringify(got?.[key] ?? null))
  .map((key) => `${key}=${JSON.stringify(got?.[key] ?? null)} (want ${JSON.stringify(want[key] ?? null)})`);

// --- scenarios --------------------------------------------------------------------------------
// `agents`: which agent writes land, and when ("during" between two groups of edits, "after" once saved).
const SCENARIOS = {
  "tab-only": { agents: [] },
  "json-during": { agents: [["json", "during"]] },
  "mermaid-during": { agents: [["mermaid", "during"]] },
  "json-after": { agents: [["json", "after"]] },
  "mermaid-after": { agents: [["mermaid", "after"]] },
  "both-during-and-after": { agents: [["json", "during"], ["mermaid", "during"], ["json", "after"], ["mermaid", "after"]] },
  "mermaid-curves": { curves: true },
};

const runScenario = async (browser, name, { agents }) => {
  const board = `sandbox/edge-styles/${run}-${name}`;
  const seeded = await postJson(`/api/mermaid/${boardPath(board)}`, { author: "agent:edge-styles-seed#5eed00", base: null, mermaid: DIAGRAM });
  if (seeded.status >= 300 && seeded.status !== 202) throw new Error(`seed: ${seeded.status} ${JSON.stringify(seeded.body)}`);
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  let page = await openTab(context, board);
  await waitFor("the converted diagram", async () => (await read(board).catch(() => null))?.scene.elements.some((element) => element.id === arrowIdOf(PAIRS.length - 1)));
  await page.reload();
  page = await (async () => { await page.close(); return openTab(context, board); })();
  const want = {};
  const writes = [];
  const agentRead = await read(board);
  const runAgents = async (when, from) => {
    for (const [kind, at] of agents) {
      if (at !== when) continue;
      const result = kind === "json" ? await agentJsonWrite(board, from ?? (await read(board)), `${when}`) : await agentMermaidWrite(board, from ?? (await read(board)), `${when}`);
      writes.push({ kind, when, status: result.status, outcome: result.body?.status ?? null, ops: (result.body?.ops ?? []).filter((op) => op.kind === "edge" && op.op !== "keep").map((op) => `${op.op}:${op.id}${op.changes ? ` ${JSON.stringify(op.changes)}` : ""}`), overwritten: (result.body?.overwritten ?? []).map((unit) => unit.label) });
    }
  };
  const half = Math.ceil(PAIRS.length / 2);
  for (const edgeName of PAIRS.slice(0, half)) want[arrowIdOf(PAIRS.indexOf(edgeName))] = await edit(page, edgeName);
  // "during": the agents read before the edits; their writes land before the autosave.
  await runAgents("during", agentRead);
  for (const edgeName of PAIRS.slice(half)) want[arrowIdOf(PAIRS.indexOf(edgeName))] = await edit(page, edgeName);
  const line = await drawLine(page);
  want[line.id] = line.style;
  await delay(2500);
  await settled(page, board, want);
  await runAgents("after", null);
  await delay(2500);
  const master = await settled(page, board, want);
  await page.screenshot({ path: path.join(shotsDir, `${name}-before-reload.png`) });
  await page.reload();
  await page.waitForFunction(() => /Loaded|Saved/.test(document.querySelector(".status")?.textContent ?? ""));
  page = await (async () => { await page.close(); return openTab(context, board); })();
  const reloaded = await sceneOf(page);
  await page.screenshot({ path: path.join(shotsDir, `${name}-after-reload.png`) });
  await context.close();
  const rows = Object.entries(want).map(([id, style]) => {
    const label = PAIRS[Number(/^s(\d+)_/.exec(id)?.[1])] ?? "line";
    const onMaster = compare(style, styleOf(master.scene.elements.find((element) => element.id === id)));
    const inTab = compare(style, styleOf(reloaded.find((element) => element.id === id)));
    return { edit: label, id, want: style, master: onMaster.length ? `LOST ${onMaster.join("; ")}` : "kept", reloaded: inTab.length ? `LOST ${inTab.join("; ")}` : "kept" };
  });
  return { board, writes, rows, lost: rows.filter((row) => row.master !== "kept" || row.reloaded !== "kept").length };
};

// Per-edge curves from Mermaid: a new board laid out by the tab, then a later apply.
const CURVES = [
  "flowchart LR",
  "  a1[\"straight from\"] e1@--> b1[\"straight to\"]",
  "  a2[\"elbow from\"] e2@-.-> b2[\"elbow to\"]",
  "  a3[\"curved from\"] --> b3[\"curved to\"]",
  "  z[\"Unrelated\"]",
  "  e1@{ curve: linear }",
  "  e2@{ curve: step }",
].join("\n");
const runCurves = async (browser) => {
  const board = `sandbox/edge-styles/${run}-mermaid-curves`;
  await postJson(`/api/mermaid/${boardPath(board)}`, { author: AGENT, base: null, mermaid: CURVES });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  let page = await openTab(context, board);
  const want = {
    a1_b1: { roundness: null, elbowed: false },
    a2_b2: { roundness: null, elbowed: true, strokeStyle: "dashed" },
    a3_b3: { roundness: { type: 2 }, elbowed: false },
  };
  const check = (elements) => Object.entries(want).map(([id, style]) => {
    const element = elements.find((item) => item.id === id && !item.isDeleted);
    const bad = Object.entries(style).filter(([key, value]) => JSON.stringify(element?.[key] ?? null) !== JSON.stringify(value)).map(([key, value]) => `${key}=${JSON.stringify(element?.[key] ?? null)} (want ${JSON.stringify(value)})`);
    return { edit: id, master: bad.length ? `LOST ${bad.join("; ")}` : "kept" };
  });
  const converted = await waitFor("the converted diagram", async () => {
    const master = await read(board).catch(() => null);
    return master?.scene.elements.some((element) => element.id === "a3_b3") ? master : null;
  });
  const rows = check(converted.scene.elements).map((row) => ({ ...row, edit: `converted ${row.edit}` }));
  // An agent makes the curved edge elbow and relabels z; the other two arrows keep their curve.
  want.a3_b3 = { roundness: null, elbowed: true };
  const mermaid = CURVES.replace("a3[\"curved from\"] -->", "a3[\"curved from\"] e3@-->").replace("z[\"Unrelated\"]", "z[\"Unrelated v2\"]") + "\n  e3@{ curve: step }";
  const write = await postJson(`/api/mermaid/${boardPath(board)}`, { author: AGENT, base: converted.version, mermaid });
  await delay(1500);
  rows.push(...check((await read(board)).scene.elements).map((row) => ({ ...row, edit: `after apply ${row.edit}` })));
  await page.close();
  page = await openTab(context, board);
  await delay(500);
  rows.push(...check(await sceneOf(page)).map((row) => ({ ...row, edit: `reloaded ${row.edit}` })));
  await page.screenshot({ path: path.join(shotsDir, "mermaid-curves.png") });
  await context.close();
  return {
    board,
    writes: [{ kind: "mermaid", when: "after", status: write.status, outcome: write.body?.status ?? null, ops: (write.body?.ops ?? []).filter((op) => op.kind === "edge").map((op) => `${op.op}:${op.id}${op.changes ? ` ${JSON.stringify(op.changes)}` : ""}`), overwritten: [] }],
    rows: rows.map((row) => ({ ...row, reloaded: "-" })),
    lost: rows.filter((row) => row.master !== "kept").length,
  };
};

const main = async () => {
  await mkdir(shotsDir, { recursive: true });
  const { chromium } = resolvePlaywright();
  const browser = await chromium.launch({ headless: true });
  const results = {};
  let lost = 0;
  let failed = 0;
  try {
    for (const [name, scenario] of Object.entries(SCENARIOS)) {
      if (only && !only.includes(name)) continue;
      try {
        const result = scenario.curves ? await runCurves(browser) : await runScenario(browser, name, scenario);
        results[name] = result;
        lost += result.lost;
        console.log(`\n=== ${name} (headless) ${result.board}`);
        for (const write of result.writes) console.log(`  agent ${write.kind} ${write.when}: HTTP ${write.status} ${write.outcome}${write.ops.length ? ` edge ops: ${write.ops.join(" | ")}` : ""}${write.overwritten.length ? ` overwritten: ${write.overwritten.join(", ")}` : ""}`);
        for (const row of result.rows) console.log(`  ${row.edit.padEnd(15)} master: ${row.master.padEnd(40)}${row.reloaded === "-" ? "" : ` after reload: ${row.reloaded}`}`);
      } catch (error) {
        failed++;
        results[name] = { error: error.stack ?? String(error) };
        console.log(`\n=== ${name}: ERROR ${error.message}`);
      }
    }
  } finally {
    await browser.close();
  }
  await writeFile(path.join(shotsDir, "report.json"), `${JSON.stringify({ run, baseUrl, results, pageErrors }, null, 2)}\n`);
  console.log(`\n${lost} lost style(s), ${failed} scenario error(s)${pageErrors.length ? `, page errors: ${pageErrors.join(" | ")}` : ""}. Report: ${path.join(shotsDir, "report.json")}`);
  process.exitCode = lost || failed ? 1 : 0;
};

await main();
