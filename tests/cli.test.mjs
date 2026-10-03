import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { test } from "node:test";
import path from "node:path";

const runCli = (args, boardsDir, env = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["tools/cli.mjs", ...args], {
    cwd: path.resolve("."),
    env: { ...process.env, XCLD_BOARDS_DIR: boardsDir, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.on("error", reject);
  child.on("close", (code) => resolve({ code, stdout, stderr }));
});

test("cli list prints human and json board indexes", async () => {
  const root = path.resolve(".test-run", `cli-${Date.now()}-${process.pid}`);
  await mkdir(path.join(root, "myproject"), { recursive: true });
  await writeFile(path.join(root, "myproject", "demo.excalidraw"), `${JSON.stringify({ type: "excalidraw", elements: [] })}\n`, "utf8");
  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(path.join(root, "myproject", "demo.mmd"), "flowchart TD\n  A-->B\n", "utf8");
  try {
    const human = await runCli(["list"], root);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /^myproject\/demo\s+board\+mmd \(mermaid pending\)\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}/m);
    assert.match(human.stdout, /1 board/);

    const json = await runCli(["list", "myproject", "--json"], root);
    assert.equal(json.code, 0, json.stderr);
    const data = JSON.parse(json.stdout);
    assert.equal(data.boards.length, 1);
    assert.equal(data.boards[0].name, "myproject/demo");
    assert.equal(data.boards[0].mermaidPending, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cli open-in-canvas writes a view inbox and list shows view pending", async () => {
  const root = path.resolve(".test-run", `cli-view-${Date.now()}-${process.pid}`);
  const checkpoints = path.join(root, "checkpoints");
  const boards = path.join(root, "boards");
  await mkdir(checkpoints, { recursive: true });
  await mkdir(boards, { recursive: true });
  await writeFile(path.join(checkpoints, "cli_cp.json"), await readFile(path.resolve("tests", "fixtures", "mcp-checkpoint-skeleton.json"), "utf8"), "utf8");
  try {
    const opened = await runCli(["open-in-canvas", "cli_cp", "chat/diagram"], boards, { XCLD_MCP_CHECKPOINTS: checkpoints });
    assert.equal(opened.code, 0, opened.stderr);
    const result = JSON.parse(opened.stdout);
    assert.equal(result.board, "chat/diagram");
    assert.equal(existsSync(path.join(boards, "chat", "diagram.view.json")), true);

    const listed = await runCli(["list"], boards, { XCLD_MCP_CHECKPOINTS: checkpoints });
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, /^chat\/diagram\s+view \(view pending\)\s+/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
