import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The .env storage settings the build writes: XCLD_HISTORY per OS (never overwritten), and the
// compatibility mapping of XCLD_STATE_DIR / XCLD_EXPORT_DIR from earlier builds (their lines
// stay). The build scripts run in a scratch copy with a stub `docker`; every case sets a scratch
// cache folder, so the real ~/.excalidraw is never touched.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const historyDefault = process.platform === "linux" ? "cache" : "volume";

const run = (command, args, options) => new Promise((resolve) => {
  execFile(command, args, options, (error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr }));
});
const available = async (command, args) => (await run(command, args, {})).code === 0;

const scripts = [
  { name: "build.ps1", ok: await available("pwsh", ["-NoProfile", "-Command", "exit 0"]), command: (dir) => ["pwsh", ["-NoProfile", "-File", path.join(dir, "build.ps1")]] },
  // build.sh on Linux/macOS (needs bash and jq); on Windows `bash` may be WSL, which sees other paths.
  { name: "build.sh", ok: process.platform !== "win32" && await available("bash", ["-c", "command -v jq"]), command: (dir) => ["bash", [path.join(dir, "build.sh")]] },
];

// Once the new settings are in .env (the second build), the old lines only get this notice.
const REPLACED = /Note: \.env has XCLD_[A-Za-z_ ]+_DIR, which Compose no longer reads \(XCLD_HISTORY and XCLD_CACHE_DIR replace them\); delete the old lines when you like\./;
const cases = [
  {
    name: "a fresh .env gets the per-OS XCLD_HISTORY",
    env: (dir) => [`XCLD_CACHE_DIR=${dir}/cache`],
    expect: (dir) => ({ XCLD_HISTORY: historyDefault, XCLD_CACHE_DIR: `${dir}/cache` }),
    folders: (dir) => ["cache", "cache/exports", ...(historyDefault === "cache" ? ["cache/history"] : [])],
    notice: [null, null],
  },
  {
    name: "XCLD_STATE_DIR=xcld-state and XCLD_EXPORT_DIR map to volume and the export folder",
    env: (dir) => ["XCLD_STATE_DIR=xcld-state", `XCLD_EXPORT_DIR=${dir}/exports-were-here`],
    expect: (dir) => ({ XCLD_HISTORY: "volume", XCLD_CACHE_DIR: `${dir}/exports-were-here`, XCLD_STATE_DIR: "xcld-state", XCLD_EXPORT_DIR: `${dir}/exports-were-here` }),
    folders: () => ["exports-were-here/exports"],
    notice: [/Note: \.env has XCLD_STATE_DIR and XCLD_EXPORT_DIR, which Compose no longer reads; mapped to XCLD_HISTORY=volume, XCLD_CACHE_DIR=.*exports-were-here \(added to \.env\)/, REPLACED],
  },
  {
    name: "a folder XCLD_STATE_DIR maps to cache in that folder",
    env: (dir) => [`XCLD_STATE_DIR=${dir}/state-was-here`],
    expect: (dir) => ({ XCLD_HISTORY: "cache", XCLD_CACHE_DIR: `${dir}/state-was-here`, XCLD_STATE_DIR: `${dir}/state-was-here` }),
    folders: () => ["state-was-here/exports", "state-was-here/history"],
    notice: [/Note: \.env has XCLD_STATE_DIR, which Compose no longer reads; mapped to XCLD_HISTORY=cache, XCLD_CACHE_DIR=/, REPLACED],
  },
  {
    name: "explicit XCLD_HISTORY and XCLD_CACHE_DIR win over the old settings, and are kept",
    env: (dir) => ["XCLD_HISTORY=cache", `XCLD_CACHE_DIR=${dir}/mine`, "XCLD_STATE_DIR=xcld-state"],
    expect: (dir) => ({ XCLD_HISTORY: "cache", XCLD_CACHE_DIR: `${dir}/mine`, XCLD_STATE_DIR: "xcld-state" }),
    folders: () => ["mine/exports", "mine/history"],
    notice: [REPLACED, REPLACED],
  },
];

const parseEnv = (text) => {
  const lines = text.split("\n").filter(Boolean);
  const counts = {};
  for (const line of lines) {
    const key = line.split("=")[0];
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return { values: Object.fromEntries(lines.map((line) => [line.split("=")[0], line.slice(line.indexOf("=") + 1)])), counts };
};

for (const script of scripts) {
  test(`${script.name}: .env storage settings (XCLD_HISTORY, XCLD_CACHE_DIR) and the XCLD_STATE_DIR / XCLD_EXPORT_DIR mapping`, { skip: script.ok ? false : `${script.name} can't run here` }, async () => {
    const base = path.resolve(".test-run", `build-env-${script.name}-${Date.now()}-${process.pid}`);
    try {
      for (const [index, item] of cases.entries()) {
        const dir = path.join(base, String(index));
        const bin = path.join(dir, "bin");
        await mkdir(bin, { recursive: true });
        for (const file of ["build.ps1", "build.sh", "pins.json"]) await copyFile(path.join(root, file), path.join(dir, file));
        await writeFile(path.join(bin, "docker"), "#!/bin/sh\nexit 0\n", "utf8");
        await chmod(path.join(bin, "docker"), 0o755);
        await writeFile(path.join(bin, "docker.cmd"), "@exit /b 0\r\n", "utf8");
        const slashed = dir.split(path.sep).join("/");
        await writeFile(path.join(dir, ".env"), ["XCLD_AUTHOR_NAME=Test", ...item.env(slashed), ""].join("\n"), "utf8");
        const [command, args] = script.command(dir);
        const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, XCLD_NPM_REGISTRY: "https://registry.example.org/" };
        for (let pass = 0; pass < 2; pass++) {
          const result = await run(command, args, { cwd: dir, env });
          assert.equal(result.code, 0, `${item.name}: ${result.stderr}`);
          const { values, counts } = parseEnv(await readFile(path.join(dir, ".env"), "utf8"));
          for (const [key, value] of Object.entries(item.expect(slashed))) assert.equal(values[key], value, `${item.name}: ${key}`);
          for (const [key, count] of Object.entries(counts)) assert.equal(count, 1, `${item.name}: ${key} written once (pass ${pass + 1})`);
          if (item.notice[pass]) assert.match(result.stdout, item.notice[pass], `${item.name} (pass ${pass + 1})`);
          else assert.doesNotMatch(result.stdout, /Note: \.env has XCLD_/, item.name);
          assert.match(result.stdout, new RegExp(`Version history \\(XCLD_HISTORY=${values.XCLD_HISTORY}\\)`), item.name);
        }
        for (const folder of item.folders(slashed)) assert.ok((await stat(path.join(dir, folder))).isDirectory(), `${item.name}: ${folder} created`);
      }
    } finally {
      await rm(base, { recursive: true, force: true, maxRetries: 5 });
    }
  });
}
