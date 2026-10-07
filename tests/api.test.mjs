import assert from "node:assert/strict";
import { mkdir, open, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { test } from "node:test";
import path from "node:path";
import { createBoardApi, validateBoardName } from "../app/server/api.mjs";

const scratchRoot = path.resolve(".test-run");

const requestStatus = (port, pathName, host) => new Promise((resolve, reject) => {
  const req = request({ host: "127.0.0.1", port, path: pathName, headers: { Host: host } }, (res) => {
    res.resume();
    res.on("end", () => resolve(res.statusCode));
  });
  req.on("error", reject);
  req.end();
});

const withServer = async (fn) => {
  const boardsDir = path.join(scratchRoot, `api-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`);
  await mkdir(boardsDir, { recursive: true });
  const api = createBoardApi({ boardsDir });
  const server = createServer((req, res) => {
    void api.handle(req, res).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end("not found");
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    await fn({ boardsDir, port });
  } finally {
    api.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(boardsDir, { recursive: true, force: true });
  }
};

const excalidraw = (id = "x") => JSON.stringify({ type: "excalidraw", elements: id ? [{ id }] : [] });

test("board name validation rejects traversal", () => {
  assert.equal(validateBoardName("fixture-a"), true);
  assert.equal(validateBoardName("a..b"), false);
  assert.equal(validateBoardName("../evil"), false);
  assert.equal(validateBoardName("a".repeat(101)), false);
});

test("api host guard and board endpoints", async () => {
  await withServer(async ({ boardsDir, port }) => {
    await writeFile(path.join(boardsDir, "fixture-a.excalidraw"), JSON.stringify({ type: "excalidraw", elements: [] }), "utf8");
    const base = `http://127.0.0.1:${port}`;
    const host = `127.0.0.1:${port}`;

    assert.equal(await requestStatus(port, "/healthz", "evil.example"), 403);

    const health = await fetch(`${base}/healthz`, { headers: { Host: host } });
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const traversal = await fetch(`${base}/api/board/a..b`, { headers: { Host: host } });
    assert.equal(traversal.status, 400);

    const badType = await fetch(`${base}/api/board/good`, { method: "PUT", headers: { Host: host, "Content-Type": "text/plain" }, body: "{}" });
    assert.equal(badType.status, 415);

    const okPut = await fetch(`${base}/api/board/good`, { method: "PUT", headers: { Host: host, "Content-Type": "application/json" }, body: JSON.stringify({ type: "excalidraw", elements: [] }) });
    assert.equal(okPut.status, 200);
  });
});

test("api accepts nested board paths, encoded slashes, and lists boards", async () => {
  await withServer(async ({ boardsDir, port }) => {
    const base = `http://127.0.0.1:${port}`;
    const host = `127.0.0.1:${port}`;

    const put = await fetch(`${base}/api/board/myproject/demo`, {
      method: "PUT",
      headers: { Host: host, "Content-Type": "application/json" },
      body: excalidraw("nested"),
    });
    assert.equal(put.status, 200);
    assert.equal(await requestStatus(port, "/api/board/myproject/../demo", host), 400);

    const literal = await fetch(`${base}/api/board/myproject/demo`, { headers: { Host: host } });
    assert.equal(literal.status, 200);
    assert.deepEqual(JSON.parse(await literal.text()).elements, [{ id: "nested" }]);

    const encoded = await fetch(`${base}/api/board/${encodeURIComponent("myproject/demo")}`, { headers: { Host: host } });
    assert.equal(encoded.status, 200);
    assert.ok(await encoded.text());

    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(path.join(boardsDir, "myproject", "demo.mmd"), "flowchart TD\n  A-->B\n", "utf8");
    const boards = await fetch(`${base}/api/boards`, { headers: { Host: host } });
    assert.equal(boards.status, 200);
    const data = await boards.json();
    assert.deepEqual(data.folders, ["myproject"]);
    assert.equal(data.boards.length, 1);
    assert.deepEqual(
      {
        name: data.boards[0].name,
        folder: data.boards[0].folder,
        leaf: data.boards[0].leaf,
        hasBoard: data.boards[0].hasBoard,
        hasMermaid: data.boards[0].hasMermaid,
      },
      { name: "myproject/demo", folder: "myproject", leaf: "demo", hasBoard: true, hasMermaid: true },
    );
    assert.equal(data.boards[0].mermaidPending, true);
    assert.match(data.boards[0].modified, /^\d{4}-\d{2}-\d{2}T/);
  });
});

// Docker Desktop bind mounts don't deliver inotify events for host-side writes, so
// polling alone (fs.watch disabled) must still publish external board changes, once.
test("polling publishes external board changes without fs.watch", async () => {
  const boardsDir = path.join(scratchRoot, `poll-${Date.now()}-${process.pid}`);
  await mkdir(path.join(boardsDir, "nested"), { recursive: true });
  const boardPath = path.join(boardsDir, "nested", "poll-me.excalidraw");
  await writeFile(boardPath, excalidraw(null), "utf8");
  const api = createBoardApi({ boardsDir, pollMs: 100, useFsWatch: false });
  const server = createServer((req, res) => {
    void api.handle(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  let stream;
  try {
    const events = [];
    stream = await new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/api/events", headers: { Host: `127.0.0.1:${port}` } }, (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk) => events.push(chunk));
        resolve(req);
      });
      req.on("error", reject);
      req.end();
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(events.join("").includes("event: board"), false, "existing boards must not fire on startup");

    await writeFile(boardPath, excalidraw("x"), "utf8");
    const deadline = Date.now() + 3000;
    while (!events.join("").includes("event: board") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    const boardEvents = events.join("").split("event: board").length - 1;
    assert.equal(boardEvents, 1, `expected exactly one board event, got ${boardEvents}`);
    assert.match(events.join(""), /"name":"nested\/poll-me"/);
  } finally {
    stream?.destroy();
    api.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await rm(boardsDir, { recursive: true, force: true });
  }
});

// Editors and agents on the host often truncate and write in pieces. A poll that lands
// mid-write must not publish the partial board; only the finished file is announced.
test("polling waits for a slow non-atomic writer before publishing", async () => {
  const boardsDir = path.join(scratchRoot, `slow-${Date.now()}-${process.pid}`);
  await mkdir(boardsDir, { recursive: true });
  const boardPath = path.join(boardsDir, "slow.excalidraw");
  await writeFile(boardPath, excalidraw(null), "utf8");
  const api = createBoardApi({ boardsDir, pollMs: 100, useFsWatch: false });
  const server = createServer((req, res) => {
    void api.handle(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const host = `127.0.0.1:${port}`;
  let stream;
  let handle;
  try {
    const arrivals = [];
    stream = await new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/api/events", headers: { Host: host } }, (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          const count = chunk.split("event: board").length - 1;
          for (let i = 0; i < count; i += 1) {
            arrivals.push(Date.now());
          }
        });
        resolve(req);
      });
      req.on("error", reject);
      req.end();
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(arrivals.length, 0, "existing boards must not fire on startup");

    const full = excalidraw("slow-writer");
    const half = Math.floor(full.length / 2);
    handle = await open(boardPath, "w");
    await handle.write(full.slice(0, half));
    await new Promise((resolve) => setTimeout(resolve, 450));
    assert.equal(arrivals.length, 0, "a half-written board must not be published");

    const finalWriteAt = Date.now();
    await handle.write(full.slice(half));
    await handle.close();
    handle = undefined;
    const deadline = Date.now() + 3000;
    while (arrivals.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(arrivals.length, 1, `expected exactly one board event, got ${arrivals.length}`);
    assert.ok(arrivals[0] >= finalWriteAt, "board event must follow the final write");

    const response = await fetch(`http://${host}/api/board/slow`, { headers: { Host: host } });
    assert.deepEqual(JSON.parse(await response.text()).elements, [{ id: "slow-writer" }]);
  } finally {
    await handle?.close();
    stream?.destroy();
    api.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await rm(boardsDir, { recursive: true, force: true });
  }
});

test("polling skips dot folders, node_modules, and symlinked directories", async (t) => {
  const boardsDir = path.join(scratchRoot, `skip-${Date.now()}-${process.pid}`);
  await mkdir(path.join(boardsDir, ".snapshots"), { recursive: true });
  await mkdir(path.join(boardsDir, "node_modules"), { recursive: true });
  await mkdir(path.join(boardsDir, "real"), { recursive: true });
  await writeFile(path.join(boardsDir, ".snapshots", "hidden.excalidraw"), excalidraw("hidden"), "utf8");
  await writeFile(path.join(boardsDir, "node_modules", "pkg.excalidraw"), excalidraw("pkg"), "utf8");
  await writeFile(path.join(boardsDir, "real", "ok.excalidraw"), excalidraw("ok"), "utf8");
  const linkPath = path.join(boardsDir, "linked");
  try {
    await symlink(path.join(boardsDir, "real"), linkPath, "junction");
  } catch (error) {
    await rm(boardsDir, { recursive: true, force: true });
    t.skip(`symlink creation failed: ${error.message}`);
    return;
  }

  const api = createBoardApi({ boardsDir, pollMs: 0, useFsWatch: false });
  const server = createServer((req, res) => {
    void api.handle(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/boards`, { headers: { Host: `127.0.0.1:${port}` } });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.deepEqual(data.boards.map((board) => board.name), ["real/ok"]);
    assert.deepEqual(data.folders, ["real"]);
  } finally {
    api.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await rm(boardsDir, { recursive: true, force: true });
  }
});