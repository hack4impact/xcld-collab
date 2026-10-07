import assert from "node:assert/strict";
import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { test } from "node:test";
import path from "node:path";
import { createBoardApi } from "../app/server/api.mjs";

const scratchRoot = path.resolve(".test-run");
const excalidraw = (id = "x") => `${JSON.stringify({ type: "excalidraw", elements: id ? [{ id }] : [] })}\n`;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parseBoardEvents = (text) => text
  .split("\n\n")
  .filter((block) => block.startsWith("event: board\n"))
  .map((block) => {
    const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
    return JSON.parse(dataLine.slice("data: ".length));
  });

const waitFor = async (condition, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = condition();
    if (value) {
      return value;
    }
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

const withApiServer = async (options, fn) => {
  const boardsDir = path.join(scratchRoot, `deleted-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`);
  await mkdir(boardsDir, { recursive: true });
  const api = createBoardApi({ boardsDir, useFsWatch: false, pollMs: 50, deleteDebounceMs: 120, ...options });
  const server = createServer((req, res) => {
    void api.handle(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    await fn({ boardsDir, port });
  } finally {
    await api.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await rm(boardsDir, { recursive: true, force: true });
  }
};

test("polling publishes one deleted event and a recreate board event", async () => {
  await withApiServer({}, async ({ boardsDir, port }) => {
    const boardPath = path.join(boardsDir, "poll-delete.excalidraw");
    await writeFile(boardPath, excalidraw("before"), "utf8");
    const stream = await openEventStream(port);
    try {
      await waitFor(() => parseBoardEvents(stream.chunks.join(""))
        .some((event) => event.kind === "board" && event.name === "poll-delete"));
      stream.chunks.length = 0;
      await unlink(boardPath);

      const deletedEvent = await waitFor(() => {
        const events = parseBoardEvents(stream.chunks.join(""));
        return events.find((event) => event.kind === "deleted");
      });
      assert.deepEqual(
        { name: deletedEvent?.name, kind: deletedEvent?.kind },
        { name: "poll-delete", kind: "deleted" },
      );

      await delay(300);
      let events = parseBoardEvents(stream.chunks.join(""));
      assert.equal(events.filter((event) => event.kind === "deleted").length, 1);

      await writeFile(boardPath, excalidraw("after"), "utf8");
      const boardEvent = await waitFor(() => {
        events = parseBoardEvents(stream.chunks.join(""));
        return events.find((event) => event.kind === "board" && event.name === "poll-delete");
      });
      assert.equal(boardEvent?.kind, "board");
      assert.equal(events.filter((event) => event.kind === "deleted").length, 1);
    } finally {
      stream.req.destroy();
    }
  });
});

test("transient delete and recreate inside the debounce window does not publish deleted", async () => {
  await withApiServer({ deleteDebounceMs: 300 }, async ({ boardsDir, port }) => {
    const boardPath = path.join(boardsDir, "transient.excalidraw");
    await writeFile(boardPath, excalidraw("before"), "utf8");
    const stream = await openEventStream(port);
    try {
      await waitFor(() => parseBoardEvents(stream.chunks.join(""))
        .some((event) => event.kind === "board" && event.name === "transient"));
      stream.chunks.length = 0;
      await unlink(boardPath);
      await delay(75);
      await writeFile(boardPath, excalidraw("after"), "utf8");
      await delay(550);

      const events = parseBoardEvents(stream.chunks.join(""));
      assert.equal(events.filter((event) => event.kind === "deleted").length, 0);
    } finally {
      stream.req.destroy();
    }
  });
});

test("deleted events include nested board paths", async () => {
  await withApiServer({}, async ({ boardsDir, port }) => {
    await mkdir(path.join(boardsDir, "nested", "path"), { recursive: true });
    const boardPath = path.join(boardsDir, "nested", "path", "board.excalidraw");
    await writeFile(boardPath, excalidraw("nested"), "utf8");
    const stream = await openEventStream(port);
    try {
      await waitFor(() => parseBoardEvents(stream.chunks.join(""))
        .some((event) => event.kind === "board" && event.name === "nested/path/board"));
      stream.chunks.length = 0;
      await unlink(boardPath);

      const deletedEvent = await waitFor(() => {
        const events = parseBoardEvents(stream.chunks.join(""));
        return events.find((event) => event.kind === "deleted");
      });
      assert.deepEqual(
        { name: deletedEvent?.name, kind: deletedEvent?.kind },
        { name: "nested/path/board", kind: "deleted" },
      );
    } finally {
      stream.req.destroy();
    }
  });
});
