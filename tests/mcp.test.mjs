import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { test } from "node:test";
import path from "node:path";

const rootDir = path.resolve(".");
const bundlePath = path.join(rootDir, "tools", "mcp.bundle.mjs");

const startServer = (boardsDir) => {
  const child = spawn(process.execPath, ["tools/cli.mjs", "mcp"], {
    cwd: rootDir,
    env: {
      ...process.env,
      XCLD_BOARDS_DIR: boardsDir,
      XCLD_PUBLIC_URL: "http://127.0.0.1:3131",
      // No board server in this test: reads fall back to the file. Never the default port,
      // which may be a real workspace.
      XCLD_API_URL: "http://127.0.0.1:1",
      XCLD_AUTO_EXPORT: "snapshot",
      XCLD_MCP_CHECKPOINTS: path.join(boardsDir, ".xcld", "mcp-checkpoints", "excalidraw-mcp-checkpoints"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const pending = new Map();
  let buffer = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve } = pending.get(message.id);
        pending.delete(message.id);
        resolve(message);
      }
    }
  });
  child.on("close", (code) => {
    for (const { reject } of pending.values()) reject(new Error(`MCP server exited ${code}: ${stderr}`));
  });
  let nextId = 1;
  const send = (method, params) => {
    const id = nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    child.stdin.write(`${JSON.stringify(message)}\n`);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`Timed out waiting for ${method}. stderr=${stderr}`));
      }, 5000).unref();
    });
  };
  const notify = (method, params = {}) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  };
  const stop = async () => {
    child.stdin.end();
    child.kill();
  };
  return { child, send, notify, stop, stderr: () => stderr };
};

const callTool = async (server, name, args = {}) => {
  const response = await server.send("tools/call", { name, arguments: args });
  assert.equal(response.error, undefined, JSON.stringify(response));
  return response.result;
};

test("xcld mcp stdio exposes board tools and returns MCP tool errors", { skip: !existsSync(bundlePath) && "Run cd app; npm ci; npm run build before MCP tests." }, async () => {
  const root = path.resolve(".test-run", `mcp-${Date.now()}-${process.pid}`);
  await mkdir(path.join(root, "p"), { recursive: true });
  await writeFile(path.join(root, "p", "design-rules.csv"), [
    "kind,rule_id,on,match,means,instruct",
    "draw,direction,,,LR,Use left-to-right flowcharts",
    "check,open-notes,,type=text;bound=false,open note,Resolve notes",
    "snapshot,on-agent-write,,,on,Snapshot before every agent write",
  ].join("\n"), "utf8");
  const server = startServer(root);
  try {
    const init = await server.send("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "xcld-test", version: "0.0.0" },
    });
    assert.equal(init.error, undefined, JSON.stringify(init));
    server.notify("notifications/initialized");

    const listedTools = await server.send("tools/list", {});
    assert.equal(listedTools.error, undefined, JSON.stringify(listedTools));
    assert.deepEqual(
      listedTools.result.tools.map((tool) => tool.name).sort(),
      ["board_url", "check_board", "diff", "list_boards", "mermaid_status", "open_in_canvas", "read_board", "snapshot", "write_board", "write_mermaid"],
    );
    for (const tool of listedTools.result.tools) {
      assert.match(tool.description, /real newline inside the quoted label/, `${tool.name} should carry the label newline convention`);
      assert.match(tool.description, /never <br\/>/);
    }

    // write_mermaid goes through the board server, which isn't running here: nothing is written.
    const write = await callTool(server, "write_mermaid", {
      board: "p/flow",
      mermaid: "flowchart TD\n  A[Start] --> B[Done]\n",
    });
    assert.equal(write.isError, true);
    assert.match(write.content[0].text, /Nothing was written: the board server .* is not reachable/);
    assert.equal(existsSync(path.join(root, "p", "flow.mmd")), false);

    const checkpointDir = path.join(root, ".xcld", "mcp-checkpoints", "excalidraw-mcp-checkpoints");
    await mkdir(checkpointDir, { recursive: true });
    await writeFile(path.join(checkpointDir, "chat_cp.json"), await readFile(path.resolve("tests", "fixtures", "mcp-checkpoint-skeleton.json"), "utf8"), "utf8");
    const open = await callTool(server, "open_in_canvas", { checkpointId: "chat_cp", board: "p/chat" });
    assert.equal(open.isError, undefined);
    assert.equal(existsSync(path.join(root, "p", "chat.view.json")), true);
    assert.match(open.content[0].text, /converts/);

    await writeFile(path.join(root, "p", "flow.excalidraw"), await readFile(path.resolve("tests", "fixtures", "fixture-a.excalidraw"), "utf8"), "utf8");

    const boards = await callTool(server, "list_boards", { folder: "p" });
    assert.equal(boards.structuredContent.boards.some((board) => board.name === "p/flow"), true);
    assert.equal(boards.structuredContent.boards.some((board) => board.name === "p/chat" && board.viewPending), true);

    const snapshot = await callTool(server, "snapshot", { board: "p/flow" });
    assert.equal(existsSync(snapshot.structuredContent.paths.board), true);
    assert.equal(existsSync(snapshot.structuredContent.paths.mermaid), true);

    await writeFile(path.join(root, "p", "flow.excalidraw"), await readFile(path.resolve("tests", "fixtures", "fixture-b.excalidraw"), "utf8"), "utf8");
    const diff = await callTool(server, "diff", { board: "p/flow", format: "text" });
    assert.match(diff.content[0].text, /~ relabeled/);

    const read = await callTool(server, "read_board", { board: "p/flow", format: "mermaid" });
    assert.match(read.content[0].text, /^flowchart TD/);
    assert.match(read.content[0].text, /version: [0-9a-f]{64} \(pass it as base to write_board or write_mermaid\)/);
    assert.match(read.structuredContent.warning, /not reachable/, "without a board server the read falls back to the file and says so");
    assert.match(read.content[0].text, /Design rules/);

    const check = await callTool(server, "check_board", { board: "p/flow" });
    assert.match(check.content[0].text, /open note/);

    const invalid = await callTool(server, "board_url", { board: "../bad" });
    assert.equal(invalid.isError, true);
    assert.match(invalid.content[0].text, /Invalid board name/);
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});
