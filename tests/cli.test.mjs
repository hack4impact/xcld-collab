import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { test } from "node:test";
import path from "node:path";

const runCli = (args, boardsDir) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["tools/cli.mjs", ...args], {
    cwd: path.resolve("."),
    env: { ...process.env, XCLD_BOARDS_DIR: boardsDir },
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
