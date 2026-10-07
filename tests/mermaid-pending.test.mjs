import assert from "node:assert/strict";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { test } from "node:test";
import path from "node:path";
import { listBoards } from "../tools/board-index.mjs";
import { MERMAID_HASH_KEY, mermaidSourceHash, recordedMermaidHashes, stampMermaidHash } from "../tools/mermaid-hash.mjs";

const SOURCE = "flowchart TD\n  A[Start] --> B[Done]\n";
const OLDER = new Date("2026-01-01T00:00:00Z");
const NEWER = new Date("2026-06-01T00:00:00Z");

const tempRoot = async (name) => {
  const root = path.resolve(".test-run", `${name}-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  return root;
};

const elements = (stamp) => {
  const base = [
    { id: "A", type: "rectangle", isDeleted: false },
    { id: "A_label", type: "text", containerId: "A", isDeleted: false },
  ];
  return stamp ? stampMermaidHash(base, stamp) : base;
};

// Writes x.mmd and x.excalidraw with explicit mtimes, like a fresh clone where checkout order decides them.
const writePair = async (root, { mermaid = SOURCE, boardElements, mermaidTime, boardTime }) => {
  await writeFile(path.join(root, "x.mmd"), mermaid, "utf8");
  await writeFile(path.join(root, "x.excalidraw"), `${JSON.stringify({ type: "excalidraw", elements: boardElements }, null, 2)}\n`, "utf8");
  await utimes(path.join(root, "x.mmd"), mermaidTime, mermaidTime);
  await utimes(path.join(root, "x.excalidraw"), boardTime, boardTime);
};

const pendingFor = async (root) => (await listBoards(root)).boards.find((board) => board.name === "x").mermaidPending;

test("mermaidSourceHash ignores BOM, CRLF and trailing whitespace but not content", () => {
  const hash = mermaidSourceHash(SOURCE);
  assert.match(hash, /^m1-[0-9a-f]{16}$/);
  assert.equal(mermaidSourceHash(`\uFEFF${SOURCE.replace(/\n/g, "\r\n")}  \n\n`), hash);
  assert.notEqual(mermaidSourceHash(SOURCE.replace("Done", "Done!")), hash);
  assert.notEqual(mermaidSourceHash(SOURCE.replace("A[Start]", "A[\"Start\nhere\"]")), hash);
});

test("stamped hashes survive JSON round trips and ignore deleted elements", () => {
  const stamped = JSON.parse(JSON.stringify(stampMermaidHash([
    { id: "keep", type: "rectangle", customData: { other: 1 }, isDeleted: false },
    { id: "gone", type: "rectangle", isDeleted: true },
  ], "m1-abc")));
  assert.deepEqual(stamped[0].customData, { other: 1, [MERMAID_HASH_KEY]: "m1-abc" });
  assert.deepEqual([...recordedMermaidHashes(stamped)], ["m1-abc"]);
  assert.deepEqual([...recordedMermaidHashes([{ ...stamped[0], isDeleted: true }])], []);
});

test("mermaid pending uses the recorded hash: a fresh clone with a newer .mmd mtime is not pending", async () => {
  const root = await tempRoot("pending-clone");
  try {
    await writePair(root, { boardElements: elements(mermaidSourceHash(SOURCE)), mermaidTime: NEWER, boardTime: OLDER });
    assert.equal(await pendingFor(root), false);

    // CRLF checkout of the same source is still the same diagram.
    await writePair(root, { mermaid: SOURCE.replace(/\n/g, "\r\n"), boardElements: elements(mermaidSourceHash(SOURCE)), mermaidTime: NEWER, boardTime: OLDER });
    assert.equal(await pendingFor(root), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mermaid pending is true when the .mmd content differs from the recorded hash, even if the board is newer", async () => {
  const root = await tempRoot("pending-rewrite");
  try {
    await writePair(root, {
      mermaid: SOURCE.replace("Done", "Shipped"),
      boardElements: elements(mermaidSourceHash(SOURCE)),
      mermaidTime: OLDER,
      boardTime: NEWER,
    });
    assert.equal(await pendingFor(root), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mermaid pending falls back to mtimes for boards without a recorded hash", async () => {
  const root = await tempRoot("pending-fallback");
  try {
    await writePair(root, { boardElements: elements(), mermaidTime: NEWER, boardTime: OLDER });
    assert.equal(await pendingFor(root), true);
    await writePair(root, { boardElements: elements(), mermaidTime: OLDER, boardTime: NEWER });
    assert.equal(await pendingFor(root), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mermaid pending stays true for a missing or empty board", async () => {
  const root = await tempRoot("pending-empty");
  try {
    const deleted = elements(mermaidSourceHash(SOURCE)).map((element) => ({ ...element, isDeleted: true }));
    await writePair(root, { boardElements: deleted, mermaidTime: OLDER, boardTime: NEWER });
    assert.equal(await pendingFor(root), true);
    await rm(path.join(root, "x.excalidraw"));
    assert.equal(await pendingFor(root), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
