// Rewrites every registry `resolved` URL in app/package-lock.json to public npm.
//
// npm records the tarball URL of whatever registry it installed through. Behind a
// mirror/proxy that is a private host, which must never be committed. Mirrors serve
// the standard `<name>/-/<file>.tgz` layout, so only the registry base changes;
// `integrity` hashes are untouched. Inside Docker, `with-registry --rewrite` maps the
// public URLs back to the configured registry in the builder stage only.
//
//   npm run lockfile:public            rewrite in place
//   npm run lockfile:public -- --check exit 1 if any URL is not public npm or
//                                      file:vendor/ (no writes)
// An optional path argument targets another lockfile (used by the tests).
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PUBLIC_REGISTRY = "https://registry.npmjs.org/";
const VENDOR_PREFIX = "file:vendor/";

const packageName = (key, entry) => entry.name ?? key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);

export const isPublicResolved = (resolved) =>
  resolved.startsWith(VENDOR_PREFIX) || /^https:\/\/registry\.npmjs\.org\/(@[^/]+\/)?[^/@]+\/-\/[^/]+\.tgz$/.test(resolved);

/** Returns the public URL for a lockfile entry's `resolved`, or throws if it isn't a registry tarball. */
export function toPublicResolved(key, entry) {
  const { resolved } = entry;
  if (resolved.startsWith(VENDOR_PREFIX)) return resolved;
  const name = packageName(key, entry);
  const file = resolved.slice(resolved.lastIndexOf("/-/") + 3);
  const suffix = `/${name}/-/${file}`;
  if (!/^https?:\/\//.test(resolved) || !file.endsWith(".tgz") || file.includes("/") || !resolved.endsWith(suffix)) {
    throw new Error(`${key}: unexpected resolved URL shape; refusing to rewrite`);
  }
  return `${PUBLIC_REGISTRY}${name}/-/${file}`;
}

export function publicizeLockfile(lock) {
  let changed = 0;
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!entry.resolved) continue;
    const next = toPublicResolved(key, entry);
    if (next !== entry.resolved) { entry.resolved = next; changed += 1; }
  }
  return changed;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const args = process.argv.slice(2);
  const lockPath = args.find((a) => !a.startsWith("--"))
    ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package-lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  if (args.includes("--check")) {
    const bad = Object.entries(lock.packages ?? {}).filter(([, e]) => e.resolved && !isPublicResolved(e.resolved));
    for (const [key] of bad) console.error(`non-public resolved URL: ${key}`);
    if (bad.length) process.exit(1);
    console.log("package-lock.json: all resolved URLs are public npm or vendor tarballs.");
  } else {
    const changed = publicizeLockfile(lock);
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    console.log(`package-lock.json: rewrote ${changed} resolved URL(s) to ${PUBLIC_REGISTRY}`);
  }
}
