import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import path from "node:path";
import { parseAutoExport } from "../tools/export.mjs";
import { snapshotBoard, snapshotsFor } from "../tools/snapshot.mjs";

test("snapshotsFor matches the exact board name, not dotted siblings", () => {
  const files = [
    "demo.20261002T212045Z.excalidraw",
    "demo.v2.20261002T235959Z.excalidraw",
    "demo.20261002T212046123Z.excalidraw",
    "demox.20261002T999999Z.excalidraw",
    "demo.notes.txt",
  ];
  assert.deepEqual(snapshotsFor("demo", files), [
    "demo.20261002T212045Z.excalidraw",
    "demo.20261002T212046123Z.excalidraw",
  ]);
  assert.deepEqual(snapshotsFor("demo.v2", files), ["demo.v2.20261002T235959Z.excalidraw"]);
});

test("snapshotsFor orders second- and millisecond-precision names by time", () => {
  const files = [
    "b.20261002T100000500Z.excalidraw",
    "b.20261002T100001Z.excalidraw",
    "b.20261002T100000Z.excalidraw",
  ];
  assert.deepEqual(snapshotsFor("b", files), [
    "b.20261002T100000Z.excalidraw",
    "b.20261002T100000500Z.excalidraw",
    "b.20261002T100001Z.excalidraw",
  ]);
});

test("snapshotBoard mirrors nested folders and keeps flat compatibility", async () => {
  const root = path.resolve(".test-run", `snap-${Date.now()}-${process.pid}`);
  await mkdir(path.join(root, "a"), { recursive: true });
  await mkdir(path.join(root, "b"), { recursive: true });
  const content = `${JSON.stringify({ type: "excalidraw", elements: [] })}\n`;
  await writeFile(path.join(root, "a", "demo.excalidraw"), content, "utf8");
  await writeFile(path.join(root, "b", "demo.excalidraw"), content, "utf8");
  await writeFile(path.join(root, "flat.excalidraw"), content, "utf8");
  try {
    const { board: aSnapshot } = await snapshotBoard("a/demo", root);
    const { board: bSnapshot } = await snapshotBoard("b/demo", root);
    const { board: flatSnapshot } = await snapshotBoard("flat", root);
    assert.match(path.relative(root, aSnapshot).split(path.sep).join("/"), /^\.snapshots\/a\/demo\.\d{8}T\d{6}\d{3}Z\.excalidraw$/);
    assert.match(path.relative(root, bSnapshot).split(path.sep).join("/"), /^\.snapshots\/b\/demo\.\d{8}T\d{6}\d{3}Z\.excalidraw$/);
    assert.match(path.relative(root, flatSnapshot).split(path.sep).join("/"), /^\.snapshots\/flat\.\d{8}T\d{6}\d{3}Z\.excalidraw$/);
    assert.equal(existsSync(aSnapshot), true);
    assert.equal(existsSync(bSnapshot), true);
    assert.equal(existsSync(flatSnapshot), true);
    const aFiles = await readdir(path.join(root, ".snapshots", "a"));
    const bFiles = await readdir(path.join(root, ".snapshots", "b"));
    assert.equal(snapshotsFor("a/demo", aFiles).length, 1);
    assert.equal(snapshotsFor("b/demo", bFiles).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot writes a Mermaid twin by default and none when XCLD_AUTO_EXPORT=off", async () => {
  const root = path.resolve(".test-run", `snap-mmd-${Date.now()}-${process.pid}`);
  await mkdir(path.join(root, "p"), { recursive: true });
  await writeFile(path.join(root, "p", "flow.excalidraw"), await readFile(path.resolve("tests", "fixtures", "demo-converted.excalidraw"), "utf8"), "utf8");
  await writeFile(path.join(root, "p", "other.excalidraw"), `${JSON.stringify({ type: "excalidraw", elements: [] })}\n`, "utf8");
  try {
    const withMermaid = await snapshotBoard("p/flow", root, { autoExport: "snapshot" });
    assert.match(withMermaid.mermaid, /flow\.\d{8}T\d{9}Z\.mmd$/);
    assert.equal(path.dirname(withMermaid.mermaid), path.dirname(withMermaid.board));
    const mermaid = await readFile(withMermaid.mermaid, "utf8");
    assert.match(mermaid, /^flowchart TD\n/);
    assert.match(mermaid, /Valid\{"Valid\?"\}/);

    const without = await snapshotBoard("p/other", root, { autoExport: "off" });
    assert.equal(without.mermaid, null);
    assert.equal(existsSync(without.board.replace(/\.excalidraw$/, ".mmd")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parseAutoExport accepts the three modes and rejects typos", () => {
  assert.equal(parseAutoExport(undefined), "snapshot");
  assert.equal(parseAutoExport(" SAVE "), "save");
  assert.equal(parseAutoExport("off"), "off");
  assert.throws(() => parseAutoExport("always"), /Invalid XCLD_AUTO_EXPORT "always"/);
});
