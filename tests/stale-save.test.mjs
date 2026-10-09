import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { test } from "node:test";
import path from "node:path";
import { createBoardApi } from "../app/server/api.mjs";

const scratchRoot = path.resolve(".test-run");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const el = (id, extra = {}) => ({ id, type: "rectangle", x: 0, y: 0, width: 10, height: 10, ...extra });
// Bodies in the tab's layout (serializeAsJSON: two-space JSON), which the server keeps byte for byte.
const board = (...elements) => `${JSON.stringify({ type: "excalidraw", version: 2, source: "test", elements: elements.map((item) => (typeof item === "string" ? el(item) : item)), appState: {}, files: {} }, null, 2)}\n`;
const ids = (text) => JSON.parse(text).elements.map((element) => element.id).sort();

const withServer = async (fn) => {
  const boardsDir = path.join(scratchRoot, `stale-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`);
  await mkdir(boardsDir, { recursive: true });
  const api = createBoardApi({ boardsDir, pollMs: 0, useFsWatch: false });
  const server = createServer((req, res) => {
    void api.handle(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/api/board/p/demo`;
  // Master is written right after the answer; settle before looking at the file.
  const put = async (body, headers = {}) => {
    const response = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json", ...headers }, body });
    await api.versions.whenIdle();
    return response;
  };
  try {
    await fn({ boardsDir, url, put, file: path.join(boardsDir, "p", "demo.excalidraw") });
  } finally {
    await api.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await rm(boardsDir, { recursive: true, force: true });
  }
};

test("GET returns the content hash as a strong ETag", async () => {
  await withServer(async ({ url, file }) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, board("a"), "utf8");
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("etag"), `"${sha256(board("a"))}"`);
    assert.equal(await response.text(), board("a"));
  });
});

test("PUT with the current If-Match fast-forwards and keeps the tab's bytes", async () => {
  await withServer(async ({ url, file, put }) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, board("a"), "utf8");
    const etag = (await fetch(url)).headers.get("etag");

    const saved = await put(board("a", "b"), { "If-Match": etag });
    assert.equal(saved.status, 200);
    const body = await saved.json();
    assert.deepEqual({ ok: body.ok, hash: body.hash, version: body.version, merged: body.merged, master: body.master }, { ok: true, hash: sha256(board("a", "b")), version: sha256(board("a", "b")), merged: false, master: undefined });
    assert.equal(saved.headers.get("etag"), `"${sha256(board("a", "b"))}"`);
    assert.equal(await readFile(file, "utf8"), board("a", "b"));

    // Scripts may send the bare hash from the JSON body.
    const bare = await put(board("a", "b", "c"), { "If-Match": body.hash });
    assert.equal(bare.status, 200);
    assert.equal((await bare.json()).merged, false);
  });
});

test("D1: a save from a stale but known base merges, and nothing is lost", async () => {
  await withServer(async ({ url, file, put }) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, board("a"), "utf8");
    const v1 = (await fetch(url)).headers.get("etag");
    // Tab A saves first; tab B still has v1.
    assert.equal((await put(board(el("a", { x: 5 }), "b"), { "If-Match": v1, "X-Xcld-Author-Name": "Ada", "X-Xcld-Tab": "tabA" })).status, 200);
    const stale = await put(board("a", "c"), { "If-Match": v1, "X-Xcld-Author-Name": "Ada", "X-Xcld-Tab": "tabB" });
    assert.equal(stale.status, 200);
    const result = await stale.json();
    assert.equal(result.merged, true);
    assert.deepEqual(ids(await readFile(file, "utf8")), ["a", "b", "c"], "both tabs' elements are on the board");
    assert.equal(JSON.parse(await readFile(file, "utf8")).elements.find((element) => element.id === "a").x, 5, "tab B didn't touch a, so tab A's move stays");
    assert.deepEqual(result.master.elements.map((element) => element.id).sort(), ["a", "b", "c"], "the merged master comes back for the tab to apply");
    assert.equal(result.hash, sha256(await readFile(file, "utf8")));
    assert.equal(stale.headers.get("etag"), `"${result.hash}"`);
    assert.deepEqual(result.applied.map((item) => [item.unitId, item.kind]), [["c", "added"]]);
  });
});

test("D1: both tabs edit the same shape; the later save takes it and the other is reported, not silently lost", async () => {
  await withServer(async ({ url, file, put }) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, board("a"), "utf8");
    const v1 = (await fetch(url)).headers.get("etag");
    assert.equal((await put(board(el("a", { x: 1 })), { "If-Match": v1, "X-Xcld-Author-Name": "Ada", "X-Xcld-Tab": "t1" })).status, 200);
    const later = await put(board(el("a", { strokeColor: "#e03131" })), { "If-Match": v1, "X-Xcld-Author-Name": "Bo", "X-Xcld-Tab": "t2" });
    const result = await later.json();
    assert.equal(result.merged, true);
    assert.deepEqual(result.overwritten.map((item) => [item.unitId, item.winner.author, item.loser.author]), [["a", "human:Bo#t2", "human:Ada#t1"]]);
    assert.equal(result.overwritten[0].loser.elements, undefined, "loser elements stay in history, not in the response");
    assert.equal(JSON.parse(await readFile(file, "utf8")).elements[0].strokeColor, "#e03131");
  });
});

test("a direct on-disk write between GET and PUT is merged with the save", async () => {
  await withServer(async ({ url, file, put }) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, board("a"), "utf8");
    const etag = (await fetch(url)).headers.get("etag");

    await writeFile(file, board("a", "agent"), "utf8");
    const saved = await put(board("a", "tab"), { "If-Match": etag });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).merged, true);
    assert.deepEqual(ids(await readFile(file, "utf8")), ["a", "agent", "tab"]);
  });
});

test("PUT with an unknown or weak If-Match is 409 unknown-base and changes nothing", async () => {
  await withServer(async ({ url, file, put }) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, board("a"), "utf8");
    const etag = (await fetch(url)).headers.get("etag");
    const unknown = await put(board("x"), { "If-Match": `"${"0".repeat(64)}"` });
    assert.equal(unknown.status, 409);
    assert.deepEqual(await unknown.json(), { error: "unknown-base", currentHash: etag.slice(1, -1) });
    assert.equal(unknown.headers.get("etag"), etag);
    const weak = await put(board("x"), { "If-Match": `W/${etag}` });
    assert.equal(weak.status, 409, "weak tags never match");
    assert.equal(await readFile(file, "utf8"), board("a"));
  });
});

test("PUT without If-Match is unguarded (last write wins)", async () => {
  await withServer(async ({ file, put }) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, board("a"), "utf8");
    const response = await put(board("script"));
    assert.equal(response.status, 200);
    assert.equal(await readFile(file, "utf8"), board("script"));
  });
});

// The upgrade path: a tab that loaded an earlier build's page saves without identity headers (with or
// without an old If-Match) and would replace the board with its stale scene.
test("a save from a tab of an earlier build is refused: 409 reload-required, nothing written", async () => {
  await withServer(async ({ url, file, put }) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, board("a"), "utf8");
    const etag = (await fetch(url)).headers.get("etag");
    const browser = { Origin: new URL(url).origin, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty" };
    for (const headers of [browser, { ...browser, "If-Match": etag }, { Origin: new URL(url).origin }, { "Sec-Fetch-Site": "same-origin" }]) {
      const refused = await put(board("stale-tab"), headers);
      assert.equal(refused.status, 409, JSON.stringify(headers));
      const body = await refused.json();
      assert.equal(body.error, "reload-required");
      assert.match(body.message, /older xcld-collab build\. Reload the page/);
      assert.equal(await readFile(file, "utf8"), board("a"), "nothing from the old tab is written");
    }
    // The same page with identity headers (the current tab) saves; so do scripts (Node's fetch
    // sends Sec-Fetch-Mode only), unguarded or with If-Match.
    const current = await put(board("a", "tab"), { ...browser, "If-Match": etag, "X-Xcld-Author-Name": "Ada", "X-Xcld-Tab": "t1" });
    assert.equal(current.status, 200);
    const script = await put(board("script"), { "Sec-Fetch-Mode": "cors" });
    assert.equal(script.status, 200);
    assert.equal(await readFile(file, "utf8"), board("script"));
  });
});

test("If-None-Match: * creates a board, or merges into one another tab created meanwhile", async () => {
  await withServer(async ({ file, put }) => {
    const created = await put(board("new"), { "If-None-Match": "*" });
    assert.equal(created.status, 200);
    assert.equal(await readFile(file, "utf8"), board("new"));

    const again = await put(board("other-tab"), { "If-None-Match": "*" });
    assert.equal(again.status, 200);
    assert.equal((await again.json()).merged, true);
    assert.deepEqual(ids(await readFile(file, "utf8")), ["new", "other-tab"]);
  });
});

test("a save based on a board deleted on disk is 409 so the tab looks again", async () => {
  await withServer(async ({ url, file, put }) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, board("a"), "utf8");
    const etag = (await fetch(url)).headers.get("etag");
    await rm(file);
    const response = await put(board("a", "b"), { "If-Match": etag });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "unknown-base", currentHash: null });
  });
});

test("concurrent PUTs from the same base all merge: every tab's element lands", async () => {
  await withServer(async ({ url, file, put }) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, board("a"), "utf8");
    const etag = (await fetch(url)).headers.get("etag");
    const responses = await Promise.all([1, 2, 3, 4].map((n) => put(board("a", `tab-${n}`), { "If-Match": etag, "X-Xcld-Author-Name": "Ada", "X-Xcld-Tab": `t${n}` })));
    assert.deepEqual(responses.map((response) => response.status), [200, 200, 200, 200]);
    assert.deepEqual(ids(await readFile(file, "utf8")), ["a", "tab-1", "tab-2", "tab-3", "tab-4"]);
  });
});

test("tab identity headers: malformed ones are rejected", async () => {
  await withServer(async ({ put }) => {
    const missingTab = await put(board("a"), { "X-Xcld-Author-Name": "Ada" });
    assert.equal(missingTab.status, 400);
    assert.equal((await missingTab.json()).error, "invalid-author");
    const badTab = await put(board("a"), { "X-Xcld-Author-Name": "Ada", "X-Xcld-Tab": "no spaces" });
    assert.equal(badTab.status, 400);
  });
});
