import os from "node:os";
import path from "node:path";

// Where versions data and `xcld history export` output live (README, "Where history lives").
// XCLD_CACHE_DIR is the cache folder as this process sees it: a host path on the host (default
// ~/.excalidraw), /xcld-cache in the compose container. Exports go to <cache>/exports/<board>/.
// XCLD_HISTORY picks where history (the server's versions data) lives: `cache`, <cache>/history/
// (the Linux default), or `volume`, the Docker volume compose mounts at XCLD_HISTORY_VOLUME_DIR
// (the Windows/macOS default). Unset (a server run outside compose): <boards>/.xcld/.
export const HISTORY_MODES = ["volume", "cache"];

export const cacheDir = (env = process.env) => path.resolve(env.XCLD_CACHE_DIR || path.join(os.homedir(), ".excalidraw"));

export const exportRoot = (env = process.env) => path.join(cacheDir(env), "exports");

export const historyMode = (env = process.env) => {
  const mode = String(env.XCLD_HISTORY ?? "").trim();
  if (!mode) return null;
  if (!HISTORY_MODES.includes(mode)) throw new Error(`XCLD_HISTORY must be "volume" or "cache", not "${mode}"`);
  return mode;
};

export const stateDirFromEnv = (env, boardsDir) => {
  const mode = historyMode(env);
  if (mode === "cache") return path.join(cacheDir(env), "history");
  if (mode === "volume") {
    if (!env.XCLD_HISTORY_VOLUME_DIR) {
      throw new Error("XCLD_HISTORY=volume: history is in the Docker volume, which only the container sees; run it there (docker exec xcld-collab xcld ...)");
    }
    return path.resolve(env.XCLD_HISTORY_VOLUME_DIR);
  }
  return path.join(path.resolve(boardsDir), ".xcld");
};

// The host's name for a path under the cache folder; compose passes the host path of the cache
// as XCLD_CACHE_HOST_DIR. Null outside the cache or without it.
export const hostPathOf = (target, env = process.env) => {
  const hostRoot = env.XCLD_CACHE_HOST_DIR;
  if (!hostRoot) return null;
  const relative = path.relative(cacheDir(env), path.resolve(target));
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const separator = hostRoot.includes("\\") && !hostRoot.includes("/") ? "\\" : "/";
  return [hostRoot.replace(/[\\/]+$/, ""), ...(relative ? relative.split(path.sep) : [])].join(separator);
};
