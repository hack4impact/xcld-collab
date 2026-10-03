const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_TOTAL_LENGTH = 512;

export const BOARD_SEGMENT_PATTERN = SEGMENT_PATTERN;

export const parseMaxDepth = (value) => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    return undefined;
  }
  return number === 0 ? undefined : number;
};

export const maxDepthFromEnv = (env = globalThis.process?.env) => parseMaxDepth(env?.XCLD_MAX_DEPTH);

export const splitBoardPath = (name) => {
  const validation = validateBoardPath(name);
  if (!validation.ok) {
    const error = new Error(validation.reason);
    error.statusCode = 400;
    throw error;
  }
  return name.split("/");
};

export const validateBoardPath = (name, options = {}) => {
  if (typeof name !== "string") {
    return { ok: false, reason: "invalid-board-name" };
  }
  if (!name || name.length > MAX_TOTAL_LENGTH) {
    return { ok: false, reason: "invalid-board-name" };
  }
  if (name.includes("\\") || name.startsWith("/") || name.endsWith("/") || name.includes("//")) {
    return { ok: false, reason: "invalid-board-path" };
  }
  if (name.includes("..")) {
    return { ok: false, reason: "invalid-board-path" };
  }
  const segments = name.split("/");
  if (segments.some((segment) => !SEGMENT_PATTERN.test(segment))) {
    return { ok: false, reason: "invalid-board-name" };
  }
  const maxDepth = options.maxDepth === undefined ? undefined : parseMaxDepth(options.maxDepth);
  if (maxDepth !== undefined && segments.length - 1 > maxDepth) {
    return { ok: false, reason: "board-depth-exceeded" };
  }
  return { ok: true, name, segments };
};

export const isValidBoardPath = (name, options = {}) => validateBoardPath(name, options).ok;

const preferredSeparator = (root) => (/^[A-Za-z]:[\\/]/.test(root) || root.startsWith("\\\\") ? "\\" : "/");

const normalizeForPrefix = (value) => value.replace(/\\/g, "/").replace(/\/+$/g, "");

export const boardFilePath = (root, name, ext, options = {}) => {
  const validation = validateBoardPath(name, options);
  if (!validation.ok) {
    const error = new Error(validation.reason);
    error.statusCode = validation.reason === "board-depth-exceeded" ? 400 : 400;
    throw error;
  }
  if (typeof root !== "string" || !root) {
    throw new Error("invalid-board-root");
  }
  if (typeof ext !== "string" || !/^\.[A-Za-z0-9]+$/.test(ext)) {
    throw new Error("invalid-board-extension");
  }
  const separator = preferredSeparator(root);
  const cleanRoot = root.replace(/[\\/]+$/g, "");
  const relative = `${validation.segments.join(separator)}${ext}`;
  const target = `${cleanRoot}${separator}${relative}`;
  const normalizedRoot = normalizeForPrefix(cleanRoot);
  const normalizedTarget = normalizeForPrefix(target);
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}/`)) {
    const error = new Error("invalid-board-path");
    error.statusCode = 400;
    throw error;
  }
  return target;
};
