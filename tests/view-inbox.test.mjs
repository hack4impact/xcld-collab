import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { test } from "node:test";
import path from "node:path";
import { createBoardApi } from "../app/server/api.mjs";
import { listBoards } from "../tools/board-index.mjs";
import { openInCanvas } from "../tools/open-in-canvas.mjs";

const scratchRoot = path.resolve(".test-run");
const fixture = path.resolve("tests", "fixtures", "mcp-checkpoint-skeleton.json");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const boardJson = (elements = [{ id: "live", type: "rectangle", isDeleted: false }]) => `${JSON.stringify({ type: "excalidraw", elements })}\n`;

const parseBoardEvents = (text) => text
  .split("\n\n")
  .filter((block) => block.startsWith("event: board\n"))
  .map((block) => JSON.parse(block.split("\n").find((line) => line.startsWith("data: ")).slice("data: ".length)));

const waitFor = async (condition, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = condition();
    if (value) return value;
    await delay(25);
  }
  return condition();
};

const openEventStream = (port) => new Promise((resolve, reject) => {
  const chunks = [];
  const req = request({ host: "127.0.0.1", port, path: "/api/events", headers: { Host: `127.0.0.1:${port}` } }, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk) => chunks.push(chunk));
    resolve({ req, chunks });
  });
  req.on("error", reject);
  req.end();
});

test("openInCanvas writes a view inbox from a valid checkpoint and drops pseudo-elements", async () => {
  const root = path.join(scratchRoot, `open-${Date.now()}-${process.pid}`);
  const cpDir = path.join(root, "checkpoints");
  const boardsDir = path.join(root, "boards");
  await mkdir(cpDir, { recursive: true });
  await mkdir(boardsDir, { recursive: true });
  await writeFile(path.join(cpDir, "good_id.json"), await readFile(fixture, "utf8"), "utf8");
  const oldCheckpointDir = process.env.XCLD_MCP_CHECKPOINTS;
  process.env.XCLD_MCP_CHECKPOINTS = cpDir;
  try {
    const result = await openInCanvas({ checkpointId: "good_id", board: "p/chat", boardsDir, publicUrl: "http://127.0.0.1:3131" });
    assert.equal(result.url, "http://127.0.0.1:3131/?board=p/chat");
    assert.equal(existsSync(path.join(boardsDir, "p", "chat.view.json")), true);
    const view = JSON.parse(await readFile(path.join(boardsDir, "p", "chat.view.json"), "utf8"));
    assert.equal(view.type, "xcld-view");
    assert.equal(view.source, "excalidraw-mcp");
    assert.equal(view.checkpointId, "good_id");
    assert.equal(view.elements.some((element) => ["cameraUpdate", "restoreCheckpoint", "delete"].includes(element.type)), false);
    assert.equal(view.elements.some((element) => element.id === "browser"), true);
  } finally {
    if (oldCheckpointDir === undefined) {
      delete process.env.XCLD_MCP_CHECKPOINTS;
    } else {
      process.env.XCLD_MCP_CHECKPOINTS = oldCheckpointDir;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("openInCanvas validates checkpoint ids and existing-board overwrite", async () => {
  const root = path.join(scratchRoot, `open-errors-${Date.now()}-${process.pid}`);
  const cpDir = path.join(root, "checkpoints");
  const boardsDir = path.join(root, "boards");
  await mkdir(cpDir, { recursive: true });
  await mkdir(path.join(boardsDir, "p"), { recursive: true });
  await writeFile(path.join(cpDir, "good.json"), await readFile(fixture, "utf8"), "utf8");
  await writeFile(path.join(boardsDir, "p", "exists.excalidraw"), boardJson(), "utf8");
  const oldCheckpointDir = process.env.XCLD_MCP_CHECKPOINTS;
  process.env.XCLD_MCP_CHECKPOINTS = cpDir;
  try {
    await assert.rejects(() => openInCanvas({ checkpointId: "../bad", board: "p/x", boardsDir }), /Invalid checkpoint id/);
    await assert.rejects(() => openInCanvas({ checkpointId: "missing", board: "p/x", boardsDir }), /was not found/);
    await assert.rejects(() => openInCanvas({ checkpointId: "good", board: "p/exists", boardsDir }), /already exists/);
    const ok = await openInCanvas({ checkpointId: "good", board: "p/exists", boardsDir, overwrite: true });
    assert.equal(existsSync(ok.path), true);
  } finally {
    if (oldCheckpointDir === undefined) {
      delete process.env.XCLD_MCP_CHECKPOINTS;
    } else {
      process.env.XCLD_MCP_CHECKPOINTS = oldCheckpointDir;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("view inbox is indexed as the board name and pending clears after live board save", async () => {
  const boardsDir = path.join(scratchRoot, `index-view-${Date.now()}-${process.pid}`);
  await mkdir(boardsDir, { recursive: true });
  await writeFile(path.join(boardsDir, "x.view.json"), JSON.stringify({ type: "xcld-view", elements: [] }), "utf8");
  let data = await listBoards(boardsDir);
  assert.deepEqual(data.boards.map((board) => board.name), ["x"]);
  assert.equal(data.boards[0].hasView, true);
  assert.equal(data.boards[0].viewPending, true);

  await delay(20);
  await writeFile(path.join(boardsDir, "x.excalidraw"), boardJson(), "utf8");
  data = await listBoards(boardsDir);
  assert.equal(data.boards[0].name, "x");
  assert.equal(data.boards[0].viewPending, false);

  await writeFile(path.join(boardsDir, "empty.excalidraw"), boardJson([]), "utf8");
  await writeFile(path.join(boardsDir, "empty.view.json"), JSON.stringify({ type: "xcld-view", elements: [] }), "utf8");
  data = await listBoards(boardsDir);
  const empty = data.boards.find((board) => board.name === "empty");
  assert.equal(empty.viewPending, true);
  await rm(boardsDir, { recursive: true, force: true });
});

test("api serves view inbox and polling publishes view events", async () => {
  const boardsDir = path.join(scratchRoot, `api-view-${Date.now()}-${process.pid}`);
  await mkdir(boardsDir, { recursive: true });
  const api = createBoardApi({ boardsDir, useFsWatch: false, pollMs: 50 });
  const server = createServer((req, res) => { void api.handle(req, res); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const stream = await openEventStream(port);
  try {
    await delay(150);
    await writeFile(path.join(boardsDir, "nested.view.json"), JSON.stringify({ type: "xcld-view", elements: [] }), "utf8");
    const viewEvent = await waitFor(() => parseBoardEvents(stream.chunks.join("")).find((event) => event.kind === "view"));
    assert.deepEqual({ name: viewEvent?.name, kind: viewEvent?.kind }, { name: "nested", kind: "view" });

    const response = await fetch(`http://127.0.0.1:${port}/api/view/nested`, { headers: { Host: `127.0.0.1:${port}` } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).type, "xcld-view");

    const boards = await fetch(`http://127.0.0.1:${port}/api/boards`, { headers: { Host: `127.0.0.1:${port}` } });
    const data = await boards.json();
    assert.equal(data.boards[0].viewPending, true);
  } finally {
    stream.req.destroy();
    await api.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await rm(boardsDir, { recursive: true, force: true });
  }
});
