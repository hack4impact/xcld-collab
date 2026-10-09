// The upgrade path, replayed: a board from a build before versions (an older tab's unstamped Mermaid
// conversion, hand-drawn shapes with "-" in their ids, recoloured arrows, and the `.mmd` inbox
// left on disk), then the upgrade, a save from a tab still running the old page, a named-source
// `write_mermaid` placed near a hand-drawn shape, and a new tab. Built synthetically: the shapes
// are the fixture's real tab conversion with the stamps a versions build adds taken off.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { test } from "node:test";
import { createBoardApi } from "../app/server/api.mjs";
import { applyMermaid } from "../tools/mermaid-apply.mjs";
import { gridLayout } from "../tools/mermaid-grid.mjs";
import { mermaidSourceHash } from "../tools/mermaid-hash.mjs";
import { parseFlowchart } from "../tools/mermaid-parse.mjs";
import { sceneToMermaid } from "../tools/to-mermaid.mjs";

const rootDir = path.resolve(".");
const needsParser = { skip: !existsSync(path.join(rootDir, "tools", "mermaid-parse.bundle.mjs")) && "Run cd app; npm ci; npm run build first (Mermaid parser bundle)." };
const BASE = JSON.parse(await readFile(path.join(rootDir, "tests", "fixtures", "mermaid-apply-base.excalidraw"), "utf8"));
const BOARD = "upgrade/legacy-board";
const AGENT = "agent:copilot-cli#a1b2c3";
const HUMAN = { "X-Xcld-Author-Name": "Ada", "X-Xcld-Tab": "ZIy1uqsRKN" };
const BLUE = "#1c7ed6";
const H1 = "_k5W-8cJdS3fGh6TzQe1Rb";
const H2 = "Vb-9nYrX2mKa7LsDq4E_0";
const SHAPES = new Set(["rectangle", "diamond", "ellipse"]);
const EXTRA = [
  "flowchart TD",
  '  FCONN["Connection"]',
  '  FROLE["App role"]',
  '  FTARGET["Target service"]',
  '  FROLE -.->|"grants"| FCONN',
  "  FCONN --> FTARGET",
  "  classDef proposed fill:#a5d8ff,stroke:#1971c2,color:#1971c2",
  "  class FCONN,FROLE,FTARGET proposed",
  "  linkStyle 1 stroke:#1c7ed6,stroke-width:3px",
].join("\n");

const live = (elements) => elements.filter((element) => !element.isDeleted);
const originOf = (element) => element?.customData?.xcldOrigin ?? null;
const labelOf = (elements, id) => live(elements).find((element) => element.type === "text" && element.containerId === id)?.originalText ?? null;
const unstamp = (element) => {
  const { customData: _drop, ...rest } = element;
  return structuredClone(rest);
};
const handDrawn = (id, x, y, text) => [
  { id, type: "rectangle", x, y, width: 240, height: 90, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, index: null, roundness: { type: 3 }, seed: 11, version: 3, versionNonce: 12, isDeleted: false, boundElements: [{ type: "text", id: `${id.slice(0, 6)}-label-x` }], updated: 1_791_000_000_000, link: null, locked: false },
  { id: `${id.slice(0, 6)}-label-x`, type: "text", x: x + 20, y: y + 32, width: 200, height: 25, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, index: null, roundness: null, seed: 13, version: 3, versionNonce: 14, isDeleted: false, boundElements: null, updated: 1_791_000_000_000, link: null, locked: false, text, fontSize: 20, fontFamily: 5, textAlign: "center", verticalAlign: "middle", containerId: id, originalText: text, autoResize: true, lineHeight: 1.25 },
];
const scene = (elements) => ({ type: "excalidraw", version: 2, source: "https://excalidraw.com", elements, appState: { viewBackgroundColor: "#ffffff" }, files: {} });

// The board as the old build left it, and its leftover inbox.
const preVersionsBoard = () => {
  const converted = BASE.elements.map(unstamp);
  const atInbox = [...converted, ...handDrawn(H1, 420, 0, "Hand drawn before the inbox")];
  // An agent read the board (the old export: ids rewritten, no comments, no linkStyle) and wrote
  // it back as the inbox; the old tab replaced the board with its conversion. Then the human drew
  // H2 and recoloured two arrows.
  const inbox = `${sceneToMermaid({ elements: atInbox }).split("\n").filter((line) => !line.includes("xcld:id")).join("\n")}\n`;
  const board = [
    ...atInbox.map((element) => (["B_C", "D_B"].includes(element.id) ? { ...element, strokeColor: BLUE, version: element.version + 1 } : element)),
    ...handDrawn(H2, 420, 200, "Hand drawn after the inbox"),
  ];
  return { inbox, board };
};

// The old page's answer to the Mermaid event: it converted the leftover inbox and saved the
// result over the board (H2 gone, arrows back to black, H1 under its rewritten id).
const oldTabConversion = (board) => board
  .filter((element) => element.id !== H2 && element.containerId !== H2)
  .map((element) => (element.type === "arrow" ? { ...element, strokeColor: "#1e1e1e" } : element))
  .map((element) => (element.id === H1 ? { ...element, id: "_k5W_8cJdS3fGh6TzQe1Rb" } : element.containerId === H1 ? { ...element, containerId: "_k5W_8cJdS3fGh6TzQe1Rb" } : element));

// What a tab's converter hands back for a Mermaid text (ids as mermaid-to-excalidraw gives them).
const tabConversion = async (source) => {
  const parsed = await parseFlowchart(source);
  const grid = gridLayout(parsed);
  return applyMermaid({ master: [], parsed, hashOfSource: mermaidSourceHash(source), now: 1, previous: null, layout: grid.boxes }).elements.map(unstamp);
};

const withUpgradedServer = async (fn) => {
  const boardsDir = path.resolve(".test-run", `upgrade-replay-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`);
  const { inbox, board } = preVersionsBoard();
  const file = path.join(boardsDir, ...`${BOARD}.excalidraw`.split("/"));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(scene(board), null, 2)}\n`, "utf8");
  const inboxFile = file.replace(/\.excalidraw$/, ".mmd");
  await writeFile(inboxFile, inbox, "utf8");
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  await utimes(inboxFile, hourAgo, hourAgo);
  await utimes(file, new Date(Date.now() - 10 * 60 * 1000), new Date(Date.now() - 10 * 60 * 1000));
  // The upgrade: a versions build starts on the old boards folder.
  const api = createBoardApi({ boardsDir, pollMs: 0, useFsWatch: false, mermaidOptions: { retryScheduleMs: [60_000, 120_000, 180_000, 240_000] } });
  const server = createServer((req, res) => {
    void api.handle(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const read = async () => {
    const response = await fetch(`${base}/api/board/${BOARD}`);
    return { version: response.headers.get("etag").replace(/"/g, ""), scene: await response.json() };
  };
  const master = async () => JSON.parse(await readFile(file, "utf8"));
  const authors = async () => {
    const folder = path.join(boardsDir, ".xcld", "history", ...BOARD.split("/"));
    const names = (await readdir(folder)).filter((name) => name.endsWith(".meta.json")).sort();
    return Promise.all(names.map(async (name) => JSON.parse(await readFile(path.join(folder, name), "utf8")).author));
  };
  try {
    await fn({ api, base, read, master, authors, board, inbox, inboxFile });
  } finally {
    await api.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await rm(boardsDir, { recursive: true, force: true, maxRetries: 5 });
  }
};

test("upgrade path replay: upgrade, an old tab's save, a named-source write near a hand-drawn shape, a new tab", needsParser, async () => {
  await withUpgradedServer(async ({ api, base, read, master, authors, board, inbox, inboxFile }) => {
    const before = board.filter((element) => !element.isDeleted);
    // The upgrade's first touch: the `init` snapshot.
    const v0 = await read();
    assert.equal(live(v0.scene.elements).length, before.length);

    // A tab still running the old page saves (as it did after every Mermaid event): refused.
    const legacy = await fetch(`${base}/api/board/${BOARD}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: base, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty" },
      body: `${JSON.stringify(scene(oldTabConversion(board)), null, 2)}\n`,
    });
    assert.equal(legacy.status, 409);
    const refused = await legacy.json();
    assert.equal(refused.error, "reload-required");
    assert.match(refused.message, /Reload the page/);
    assert.equal((await read()).version, v0.version, "nothing from the old tab was merged");

    // The agent's named-source write, placed near the human's H2: no extra shapes yet, so a tab lays it out.
    const written = await (await fetch(`${base}/api/mermaid/${BOARD}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ author: AGENT, source: "extra", base: v0.version, position: `near:${H2}`, mermaid: EXTRA }),
    })).json();
    assert.equal(written.status, "needs-tab", JSON.stringify(written));
    assert.equal(written.reason, "board has no shapes from Mermaid source extra");

    // A new tab opens: it asks for pending writes. The leftover inbox predates the upgrade and is
    // adopted as source `main`, not queued as a new diagram.
    const { pending } = await (await fetch(`${base}/api/mermaid/${BOARD}?pending`)).json();
    assert.deepEqual(pending.map((item) => [item.source, item.author]), [["extra", AGENT]], "only the agent's write waits");
    await api.versions.whenIdle();
    const state = await api.versions.readState(BOARD);
    assert.equal(state.mermaidSources.main.hash, mermaidSourceHash(inbox));
    assert.equal(state.mermaidSources.main.author, "init");
    const adopted = await master();
    for (const id of ["A", "B", "C", "D", "G", "A_B", "B_C", "B_D", "D_B"]) {
      const element = adopted.elements.find((candidate) => candidate.id === id);
      assert.equal(originOf(element)?.mermaid?.source, "main", `${id} adopted as main`);
      assert.equal(originOf(element)?.mermaid?.hash, mermaidSourceHash(inbox));
    }
    assert.equal(originOf(adopted.elements.find((element) => element.id === "A")).active, "mermaid", "as the inbox says: Mermaid active");
    assert.deepEqual(originOf(adopted.elements.find((element) => element.id === "B_C")).canvas?.author, "init", "recoloured since the inbox: canvas active");
    assert.equal(originOf(adopted.elements.find((element) => element.id === "B_C")).active, "canvas");
    for (const id of [H1, H2]) assert.equal(originOf(adopted.elements.find((element) => element.id === id)), null, `${id} is hand-drawn: not adopted`);
    assert.deepEqual(live(adopted.elements).map((element) => [element.id, element.x, element.y, element.strokeColor]), live(board).map((element) => [element.id, element.x, element.y, element.strokeColor]), "adoption changes nothing on the board");
    // Asking again is a no-op: the inbox is main's applied Mermaid now.
    assert.equal((await api.mermaids.fromFile(BOARD)).status, "applied");

    // The tab lays out the extra write.
    const converted = await tabConversion(EXTRA);
    const landed = await (await fetch(`${base}/api/mermaid/${BOARD}?layout=${written.pendingId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hash: written.hash, elements: converted, files: {} }),
    })).json();
    assert.equal(landed.status, "merged", JSON.stringify(landed));
    assert.equal(landed.via, "tab");
    await api.versions.whenIdle();

    // The new tab saves an edit (it moved H1).
    const v1 = await read();
    const moved = v1.scene.elements.map((element) => (element.id === H1 ? { ...element, x: element.x + 30, version: element.version + 1 } : element));
    const saved = await fetch(`${base}/api/board/${BOARD}`, { method: "PUT", headers: { "Content-Type": "application/json", ...HUMAN, "If-Match": `"${v1.version}"` }, body: JSON.stringify({ ...v1.scene, elements: moved }) });
    assert.equal(saved.status, 200, await saved.clone().text());
    await api.versions.whenIdle();

    const after = await master();
    const ids = live(after.elements).map((element) => element.id);
    assert.deepEqual(ids.filter((id) => /_2(_label)?$/.test(id)), [], "no _2 duplicates");
    for (const element of before) {
      const kept = after.elements.find((candidate) => candidate.id === element.id);
      assert.ok(kept && !kept.isDeleted, `${element.id} kept under its own id`);
      assert.equal(kept.text ?? null, element.text ?? null);
    }
    assert.equal(ids.includes("_k5W_8cJdS3fGh6TzQe1Rb"), false, "no copy of H1 under the rewritten id");
    assert.equal(after.elements.find((element) => element.id === H1).x, 450, "the new tab's edit landed");
    for (const id of ["B_C", "D_B"]) assert.equal(after.elements.find((element) => element.id === id).strokeColor, BLUE, `${id} keeps its colour`);
    const extra = live(after.elements).filter((element) => originOf(element)?.mermaid?.source === "extra");
    assert.deepEqual(extra.filter((element) => SHAPES.has(element.type)).map((element) => element.id).sort(), ["extra:FCONN", "extra:FROLE", "extra:FTARGET"]);
    const linked = after.elements.find((element) => element.id === "extra:FCONN_FTARGET");
    assert.deepEqual([linked.strokeColor, linked.strokeWidth], [BLUE, 3], "the extra write's linkStyle");
    assert.equal(live(after.elements).filter((element) => SHAPES.has(element.type)).length, before.filter((element) => SHAPES.has(element.type)).length + 3);
    const history = await authors();
    assert.equal(history.includes("external"), false, "the inbox was never applied as an external write");
    assert.deepEqual(history.slice(0, 2), ["init", "init"], "the init snapshot, then the adoption");
    assert.ok(history.includes(AGENT));
    assert.equal((await api.versions.readState(BOARD)).open?.author, "human:Ada#ZIy1uqsRKN", "the new tab's turn is open");
    assert.equal(await readFile(inboxFile, "utf8"), inbox, "the inbox file is left as it was");

    // Later Mermaid writes of main: the agent reads the board and writes it back with a relabel of
    // H1 and of A. Nothing is duplicated, extra is left alone, the blue arrows stay.
    const v2 = await read();
    const exported = sceneToMermaid(v2.scene);
    assert.match(exported, /%% xcld:id _k5W_8cJdS3fGh6TzQe1Rb "_k5W-8cJdS3fGh6TzQe1Rb"/);
    const relabel = exported.replace('["Hand drawn before the inbox"]', '["Hand drawn (renamed)"]').replace('A["Start"]', 'A["Begin"]');
    const rewritten = await (await fetch(`${base}/api/mermaid/${BOARD}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ author: AGENT, base: v2.version, mermaid: relabel }) })).json();
    assert.equal(rewritten.status, "merged", JSON.stringify(rewritten));
    assert.deepEqual(rewritten.ops.filter((op) => op.op.startsWith("add")), [], "nothing added");
    const relabelledIds = rewritten.ops.filter((op) => op.op === "relabel").map((op) => op.id);
    // (D's two-line label comes back on one line: to-mermaid writes labels on one line, as before.)
    assert.deepEqual(relabelledIds.filter((id) => id !== "D").sort(), ["A", H1]);
    assert.ok(rewritten.ops.some((op) => op.op === "skip" && op.id === "extra:FCONN"), "another source's shapes are left alone");
    await api.versions.whenIdle();
    const relabelled = await master();
    assert.equal(labelOf(relabelled.elements, H1), "Hand drawn (renamed)");
    assert.equal(labelOf(relabelled.elements, "A"), "Begin");
    for (const id of ["B_C", "D_B"]) assert.equal(relabelled.elements.find((element) => element.id === id).strokeColor, BLUE);
    assert.equal(live(relabelled.elements).length, live(after.elements).length);

    // A main write that drops D deletes it (adopted: main's own), never a hand-drawn shape. The
    // agent edits a fresh export, so linkStyle numbers follow the remaining edges.
    const v3 = await read();
    const goesWithD = (element) => element.id === "D" || element.containerId === "D" || element.startBinding?.elementId === "D" || element.endBinding?.elementId === "D";
    const withoutD = sceneToMermaid({ elements: v3.scene.elements.filter((element) => !goesWithD(element)) });
    const dropped = await (await fetch(`${base}/api/mermaid/${BOARD}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ author: AGENT, base: v3.version, mermaid: withoutD }) })).json();
    assert.equal(dropped.status, "merged", JSON.stringify(dropped));
    assert.ok(dropped.ops.some((op) => op.op === "delete" && op.id === "D"));
    await api.versions.whenIdle();
    const last = await master();
    assert.equal(live(last.elements).some((element) => element.id === "D"), false);
    for (const id of [H1, H2, "extra:FCONN"]) assert.equal(last.elements.find((element) => element.id === id).isDeleted, false, `${id} stays`);
    assert.equal(last.elements.find((element) => element.id === "B_C").strokeColor, BLUE);
  });
});

test("a leftover inbox is adopted only when it predates the upgrade; a new one is a write as before", needsParser, async () => {
  await withUpgradedServer(async ({ api, read, master, inboxFile, inbox }) => {
    await read();
    // Rewritten after the upgrade (an agent or editor writing the file): applied as a write.
    const next = inbox.replace('A["Start"]', 'A["From a file"]');
    await writeFile(inboxFile, next, "utf8");
    const result = await api.mermaids.fromFile(BOARD);
    assert.notEqual(result.status, "adopted");
    await api.versions.whenIdle();
    assert.equal(labelOf((await master()).elements, "A"), "From a file", "the diagram's nodes are on the board: applied in place");
    assert.deepEqual(live((await master()).elements).map((element) => element.id).filter((id) => /_2$/.test(id)), []);
  });
});
