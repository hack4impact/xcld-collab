import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The experimental chat widget is opt-in: nothing in the default setup may enable it.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(root, file), "utf8");

test("build scripts never write COMPOSE_PROFILES into .env", async () => {
  for (const file of ["build.ps1", "build.sh"]) {
    const source = await read(file);
    assert.doesNotMatch(source, /(\+=|printf)\s*['"]COMPOSE_PROFILES/, `${file} seeds COMPOSE_PROFILES`);
    assert.match(source, /COMPOSE_PROFILES=widget to \.env/, `${file} lacks the opt-in notice`);
  }
});

test("compose starts only the canvas unless the widget profile is enabled", async () => {
  const compose = await read("compose.yaml");
  const services = compose.split(/^services:\s*$/m)[1].split(/^\S/m)[0];
  const blocks = services.split(/^ {2}(?=[a-z][\w-]*:\s*$)/m).filter((block) => block.trim());
  const byName = Object.fromEntries(blocks.map((block) => [block.match(/^([\w-]+):/)[1], block]));
  assert.deepEqual(Object.keys(byName).sort(), ["canvas", "mcp"]);
  assert.doesNotMatch(byName.canvas, /^\s+profiles:/m);
  assert.match(byName.mcp, /^\s+profiles:\s*\["widget"\]\s*$/m);
});

test("shipped VS Code MCP config lists only the xcld tools server", async () => {
  const config = JSON.parse(await read(".vscode/mcp.json"));
  assert.deepEqual(Object.keys(config.servers), ["xcld"]);
});
