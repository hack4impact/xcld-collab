import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { test } from "node:test";
import path from "node:path";
import { createBoardApi } from "../app/server/api.mjs";

const fixture = () => readFile(path.resolve("tests", "fixtures", "demo-converted.excalidraw"), "utf8");

const withApi = async (options, fn) => {
  const boardsDir = path.resolve(".test-run", `export-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`);
  await mkdir(boardsDir, { recursive: true });
  const api = createBoardApi({ boardsDir, pollMs: 100, useFsWatch: false, ...options });
  const server = createServer((req, res) => {
    void api.handle(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    await fn({ boardsDir, base: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` });
  } finally {
    api.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await rm(boardsDir, { recursive: true, force: true });
  }
};

const waitFor = async (check, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
};

test("XCLD_AUTO_EXPORT=save exports browser saves and on-disk edits to boards/.exports, never the inbox", async () => {
  await withApi({ autoExport: "save" }, async ({ boardsDir, base, host }) => {
    const put = await fetch(`${base}/api/board/proj/flow`, {
      method: "PUT",
      headers: { Host: host, "Content-Type": "application/json" },
      body: await fixture(),
    });
    assert.equal(put.status, 200);
    const exported = path.join(boardsDir, ".exports", "proj", "flow.mmd");
    assert.equal(existsSync(exported), true, "PUT should write the export");
    assert.match(await readFile(exported, "utf8"), /Valid\{"Valid\?"\}/);
    assert.equal(existsSync(path.join(boardsDir, "proj", "flow.mmd")), false, "the inbox must never be written");

    await new Promise((resolve) => setTimeout(resolve, 300));
    await mkdir(path.join(boardsDir, "other"), { recursive: true });
    await writeFile(path.join(boardsDir, "other", "agent.excalidraw"), await fixture(), "utf8");
    const agentExport = path.join(boardsDir, ".exports", "other", "agent.mmd");
    assert.equal(await waitFor(() => existsSync(agentExport)), true, "an on-disk edit should be exported by the poll");

    const list = await (await fetch(`${base}/api/boards`, { headers: { Host: host } })).json();
    assert.deepEqual(list.boards.map((board) => board.name).sort(), ["other/agent", "proj/flow"], "exports must not appear as boards");
  });
});

test("default snapshot mode writes no always-current export", async () => {
  await withApi({ autoExport: "snapshot" }, async ({ boardsDir, base, host }) => {
    const put = await fetch(`${base}/api/board/flow`, {
      method: "PUT",
      headers: { Host: host, "Content-Type": "application/json" },
      body: await fixture(),
    });
    assert.equal(put.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(existsSync(path.join(boardsDir, ".exports")), false);
  });
});
