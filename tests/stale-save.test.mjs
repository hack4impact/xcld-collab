import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { test } from "node:test";
import path from "node:path";
import { createBoardApi } from "../app/server/api.mjs";

const scratchRoot = path.resolve(".test-run");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const board = (id) => `${JSON.stringify({ type: "excalidraw", elements: [{ id }] })}\n`;

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
  const put = (body, headers = {}) => fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
  try {
    await fn({ boardsDir, url, put, file: path.join(boardsDir, "p", "demo.excalidraw") });
  } finally {
    api.close();
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

test("PUT with a matching If-Match saves and returns the new hash", async () => {
  await withServer(async ({ url, file, put }) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, board("a"), "utf8");
    const etag = (await fetch(url)).headers.get("etag");

    const saved = await put(board("b"), { "If-Match": etag });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { ok: true, hash: sha256(board("b")) });
    assert.equal(saved.headers.get("etag"), `"${sha256(board("b"))}"`);
    assert.equal(await readFile(file, "utf8"), board("b"));

    // Scripts may send the bare hash from the JSON body.
    const bare = await put(board("c"), { "If-Match": sha256(board("b")) });
    assert.equal(bare.status, 200);
  });
});

test("PUT with a stale If-Match is rejected with 409 and the current hash", async () => {
  await withServer(async ({ url, file, put }) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, board("a"), "utf8");
    const etag = (await fetch(url)).headers.get("etag");
    assert.equal((await put(board("b"), { "If-Match": etag })).status, 200);

    const stale = await put(board("old-tab"), { "If-Match": etag });
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), { error: "stale-save", currentHash: sha256(board("b")) });
    assert.equal(stale.headers.get("etag"), `"${sha256(board("b"))}"`);
    assert.equal(await readFile(file, "utf8"), board("b"));

    const weak = await put(board("weak"), { "If-Match": `W/"${sha256(board("b"))}"` });
    assert.equal(weak.status, 409, "weak tags never match");
  });
});

test("a direct on-disk write between GET and PUT is detected", async () => {
  await withServer(async ({ url, file, put }) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, board("a"), "utf8");
    const etag = (await fetch(url)).headers.get("etag");

    await writeFile(file, board("agent"), "utf8");
    const stale = await put(board("tab"), { "If-Match": etag });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).currentHash, sha256(board("agent")));
    assert.equal(await readFile(file, "utf8"), board("agent"));
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

test("creating a board: If-None-Match: * guards against an existing file", async () => {
  await withServer(async ({ file, put }) => {
    const created = await put(board("new"), { "If-None-Match": "*" });
    assert.equal(created.status, 200);
    assert.equal(await readFile(file, "utf8"), board("new"));

    const again = await put(board("other-tab"), { "If-None-Match": "*" });
    assert.equal(again.status, 409);
    assert.equal((await again.json()).currentHash, sha256(board("new")));

    await rm(file);
    const missing = await put(board("x"), { "If-Match": `"${sha256(board("new"))}"` });
    assert.equal(missing.status, 409, "If-Match needs the file to exist");
    assert.deepEqual(await missing.json(), { error: "stale-save", currentHash: null });
  });
});

test("concurrent PUTs with the same If-Match: exactly one wins", async () => {
  await withServer(async ({ url, file, put }) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, board("a"), "utf8");
    const etag = (await fetch(url)).headers.get("etag");
    const statuses = (await Promise.all([1, 2, 3, 4].map((n) => put(board(`tab-${n}`), { "If-Match": etag }))))
      .map((response) => response.status)
      .sort();
    assert.deepEqual(statuses, [200, 409, 409, 409]);
  });
});
