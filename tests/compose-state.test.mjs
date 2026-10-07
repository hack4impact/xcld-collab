import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { exportRoot, hostPathOf, stateDirFromEnv } from "../tools/storage.mjs";

// compose.yaml: one host folder, XCLD_CACHE_DIR, mounted at /xcld-cache, plus the xcld-state
// volume; XCLD_HISTORY picks which one holds history. Checked with `docker compose config` (no
// daemon needed); skipped when the docker CLI isn't installed.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const composeConfig = (env) => new Promise((resolve) => {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("XCLD_") && key !== "COMPOSE_PROFILES"));
  execFile("docker", ["compose", "--env-file", env.file, "-f", path.join(root, "compose.yaml"), "config", "--format", "json"], { env: { ...clean, XCLD_TAG: "test", ...env.vars } }, (error, stdout, stderr) => {
    resolve({ error, stdout, stderr });
  });
});

const dockerAvailable = await new Promise((resolve) => {
  execFile("docker", ["compose", "version"], (error) => resolve(!error));
});

test("compose: history in the xcld-state volume by default, or in <cache>/history with XCLD_HISTORY=cache; exports in <cache>/exports", { skip: dockerAvailable ? false : "docker CLI not installed" }, async () => {
  const dir = path.resolve(".test-run", `compose-${Date.now()}-${process.pid}`);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "empty.env");
  await writeFile(file, "", "utf8");
  try {
    const mounts = (config) => Object.fromEntries(config.services.canvas.volumes.map((volume) => [volume.target, volume]));
    // What the server and `xcld` in the container make of the environment compose gives them.
    const inContainer = (environment) => ({
      history: stateDirFromEnv(environment, "/boards"),
      exports: exportRoot(environment),
      hostExports: hostPathOf(path.join(exportRoot(environment), "sandbox", "demo"), environment),
    });

    const byDefault = await composeConfig({ file, vars: {} });
    assert.equal(byDefault.error, null, byDefault.stderr);
    const config = JSON.parse(byDefault.stdout);
    const environment = config.services.canvas.environment;
    assert.deepEqual([mounts(config)["/xcld-state"].type, mounts(config)["/xcld-state"].source], ["volume", "xcld-state"]);
    assert.ok(config.volumes["xcld-state"], "the volume is declared");
    const cache = mounts(config)["/xcld-cache"];
    assert.deepEqual([cache.type, cache.source], ["bind", path.join(os.homedir(), ".excalidraw")], "the cache is the host's ~/.excalidraw");
    assert.deepEqual(
      [environment.XCLD_HISTORY, environment.XCLD_CACHE_DIR, environment.XCLD_HISTORY_VOLUME_DIR, environment.XCLD_CACHE_HOST_DIR],
      ["volume", "/xcld-cache", "/xcld-state", "~/.excalidraw"],
    );
    for (const gone of ["XCLD_STATE_DIR", "XCLD_EXPORT_DIR", "XCLD_EXPORT_HOST_DIR"]) assert.equal(environment[gone], undefined, gone);
    assert.deepEqual(inContainer(environment), {
      history: path.resolve("/xcld-state"),
      exports: path.join(path.resolve("/xcld-cache"), "exports"),
      hostExports: "~/.excalidraw/exports/sandbox/demo",
    });

    const folder = path.join(dir, "cache");
    const bound = await composeConfig({ file, vars: { XCLD_HISTORY: "cache", XCLD_CACHE_DIR: folder } });
    assert.equal(bound.error, null, bound.stderr);
    const boundConfig = JSON.parse(bound.stdout);
    const boundEnvironment = boundConfig.services.canvas.environment;
    assert.deepEqual([mounts(boundConfig)["/xcld-cache"].type, mounts(boundConfig)["/xcld-cache"].source], ["bind", folder]);
    assert.deepEqual([boundEnvironment.XCLD_HISTORY, boundEnvironment.XCLD_CACHE_DIR, boundEnvironment.XCLD_CACHE_HOST_DIR], ["cache", "/xcld-cache", folder]);
    assert.deepEqual(inContainer(boundEnvironment), {
      history: path.join(path.resolve("/xcld-cache"), "history"),
      exports: path.join(path.resolve("/xcld-cache"), "exports"),
      hostExports: [folder, "exports", "sandbox", "demo"].join(folder.includes("/") ? "/" : "\\"),
    });

    // A .env from an earlier build of this branch: compose ignores the old settings (the build
    // maps them, see build.ps1 / build.sh).
    const legacy = await composeConfig({ file, vars: { XCLD_STATE_DIR: path.join(dir, "old-state"), XCLD_EXPORT_DIR: path.join(dir, "old-export") } });
    assert.equal(legacy.error, null, legacy.stderr);
    assert.deepEqual(JSON.parse(legacy.stdout).services.canvas, config.services.canvas);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("storage: XCLD_HISTORY picks the history folder; exports always go to <cache>/exports", () => {
  const cache = path.resolve("some-cache");
  assert.equal(stateDirFromEnv({}, "boards"), path.join(path.resolve("boards"), ".xcld"), "outside compose: boards/.xcld");
  assert.equal(stateDirFromEnv({ XCLD_HISTORY: "cache", XCLD_CACHE_DIR: cache }, "boards"), path.join(cache, "history"));
  assert.equal(stateDirFromEnv({ XCLD_HISTORY: "volume", XCLD_HISTORY_VOLUME_DIR: "/v" }, "boards"), path.resolve("/v"));
  assert.throws(() => stateDirFromEnv({ XCLD_HISTORY: "volume" }, "boards"), /only the container sees/);
  assert.throws(() => stateDirFromEnv({ XCLD_HISTORY: "folder" }, "boards"), /must be "volume" or "cache"/);
  assert.equal(exportRoot({ XCLD_CACHE_DIR: cache }), path.join(cache, "exports"));
  assert.equal(exportRoot({}), path.join(os.homedir(), ".excalidraw", "exports"));
  assert.equal(hostPathOf(path.join(cache, "exports", "a"), { XCLD_CACHE_DIR: cache, XCLD_CACHE_HOST_DIR: "C:\\cache\\" }), "C:\\cache\\exports\\a");
  assert.equal(hostPathOf(path.resolve("elsewhere"), { XCLD_CACHE_DIR: cache, XCLD_CACHE_HOST_DIR: "~/.excalidraw" }), null);
  assert.equal(hostPathOf(path.join(cache, "exports"), { XCLD_CACHE_DIR: cache }), null);
});
