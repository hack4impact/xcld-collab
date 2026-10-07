import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isPublicResolved, publicizeLockfile, toPublicResolved } from "../app/scripts/public-lockfile.mjs";

const readJson = (file) => JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"));

test("app/package-lock.json is v3, in sync with package.json and has only public npm or vendor URLs", () => {
  const lock = readJson("../app/package-lock.json");
  const pkg = readJson("../app/package.json");
  assert.equal(lock.lockfileVersion, 3);
  const root = lock.packages[""];
  assert.deepEqual(root.dependencies, pkg.dependencies);
  assert.deepEqual(root.devDependencies, pkg.devDependencies);
  const bad = Object.entries(lock.packages).filter(([, e]) => e.resolved && !isPublicResolved(e.resolved)).map(([key]) => key);
  assert.deepEqual(bad, [], "run `npm run lockfile:public` in app/");
});

test("lockfile rewrite keeps the tarball path and integrity, and refuses unexpected shapes", () => {
  const mirror = "https://mirror.example.test/npm/registry/";
  const lock = {
    packages: {
      "": { name: "x" },
      "node_modules/react": { resolved: `${mirror}react/-/react-18.3.1.tgz`, integrity: "sha512-a" },
      "node_modules/@types/node": { resolved: `${mirror}@types/node/-/node-22.18.6.tgz`, integrity: "sha512-b" },
      "node_modules/string-width-cjs": { name: "string-width", resolved: `${mirror}string-width/-/string-width-4.2.3.tgz` },
      "node_modules/@excalidraw/math": { resolved: "file:vendor/math.tgz", integrity: "sha512-c" },
    },
  };
  assert.equal(publicizeLockfile(lock), 3);
  assert.equal(lock.packages["node_modules/react"].resolved, "https://registry.npmjs.org/react/-/react-18.3.1.tgz");
  assert.equal(lock.packages["node_modules/react"].integrity, "sha512-a");
  assert.equal(lock.packages["node_modules/@types/node"].resolved, "https://registry.npmjs.org/@types/node/-/node-22.18.6.tgz");
  assert.equal(lock.packages["node_modules/string-width-cjs"].resolved, "https://registry.npmjs.org/string-width/-/string-width-4.2.3.tgz");
  assert.equal(lock.packages["node_modules/@excalidraw/math"].resolved, "file:vendor/math.tgz");
  assert.equal(publicizeLockfile(lock), 0);
  assert.throws(() => toPublicResolved("node_modules/react", { resolved: `${mirror}preact/-/preact-1.0.0.tgz` }), /unexpected/);
  assert.throws(() => toPublicResolved("node_modules/x", { resolved: "git+https://example.test/x.git" }), /unexpected/);
});

test("lockfile:public --check exits non-zero on any non-public host and names only the entry", () => {
  const root = path.resolve(".test-run", `lockfile-${Date.now()}-${process.pid}`);
  mkdirSync(root, { recursive: true });
  const script = new URL("../app/scripts/public-lockfile.mjs", import.meta.url);
  const check = (resolved) => {
    const file = path.join(root, "package-lock.json");
    writeFileSync(file, JSON.stringify({ lockfileVersion: 3, packages: {
      "node_modules/@excalidraw/math": { resolved: "file:vendor/math.tgz" },
      "node_modules/react": { resolved },
    } }));
    return spawnSync(process.execPath, [fileURLToPath(script), "--check", file], { encoding: "utf8" });
  };
  try {
    assert.equal(check("https://registry.npmjs.org/react/-/react-18.3.1.tgz").status, 0);
    for (const bad of [
      "https://mirror.example.test/npm/registry/react/-/react-18.3.1.tgz",
      "http://registry.npmjs.org/react/-/react-18.3.1.tgz",
      "https://registry.npmjs.org.example.test/react/-/react-18.3.1.tgz",
      "https://registry.yarnpkg.com/react/-/react-18.3.1.tgz",
    ]) {
      const result = check(bad);
      assert.equal(result.status, 1, bad);
      assert.match(result.stderr, /non-public resolved URL: node_modules\/react/);
      assert.ok(!result.stderr.includes("example.test"), "the URL itself is not echoed");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});