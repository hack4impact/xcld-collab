import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { boardFilePath, maxDepthFromEnv, validateBoardPath } from "./board-path.mjs";

const CHECKPOINT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const PSEUDO_TYPES = new Set(["cameraUpdate", "restoreCheckpoint", "delete"]);

export const checkpointsDir = () => path.resolve(
  process.env.XCLD_MCP_CHECKPOINTS
    || "/boards/.xcld/mcp-checkpoints/excalidraw-mcp-checkpoints",
);

export const validateCheckpointId = (id) => {
  if (typeof id !== "string" || !CHECKPOINT_ID_PATTERN.test(id) || id.length > 64) {
    throw new Error("Invalid checkpoint id: use 1-64 letters, digits, hyphens, or underscores.");
  }
  return id;
};

const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
};

export const checkpointPath = (id, root = checkpointsDir()) => {
  validateCheckpointId(id);
  const base = path.resolve(root);
  const file = path.resolve(base, `${id}.json`);
  if (!inside(base, file)) {
    throw new Error("Invalid checkpoint path.");
  }
  return file;
};

export const filterViewElements = (elements) => {
  if (!Array.isArray(elements)) {
    throw new Error("Checkpoint is not a valid Excalidraw checkpoint: missing elements array.");
  }
  return elements.filter((element) => element && !PSEUDO_TYPES.has(element.type));
};

export const openInCanvas = async ({
  checkpointId,
  board,
  overwrite = false,
  boardsDir = path.resolve(process.env.XCLD_BOARDS_DIR || path.resolve("boards")),
  publicUrl = (process.env.XCLD_PUBLIC_URL || "http://127.0.0.1:3100").replace(/\/+$/g, ""),
}) => {
  validateCheckpointId(checkpointId);
  if (!validateBoardPath(board, { maxDepth: maxDepthFromEnv() }).ok) {
    throw new Error(`Invalid board name: ${board} (use path segments with letters, digits, ".", "_" or "-"; start each segment with a letter or digit).`);
  }

  const cpPath = checkpointPath(checkpointId);
  if (!existsSync(cpPath)) {
    throw new Error(`Checkpoint ${checkpointId} was not found. Draw it in the chat widget first, or check the checkpoint id.`);
  }

  const liveBoardPath = path.resolve(boardFilePath(boardsDir, board, ".excalidraw", { maxDepth: maxDepthFromEnv() }));
  if (existsSync(liveBoardPath) && !overwrite) {
    throw new Error(`Board ${board}.excalidraw already exists. Snapshot it first, then retry with overwrite=true or --overwrite if you want the canvas to replace it from the widget view.`);
  }

  let checkpoint;
  try {
    checkpoint = JSON.parse(await readFile(cpPath, "utf8"));
  } catch (error) {
    throw new Error(`Checkpoint ${checkpointId} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }

  const elements = filterViewElements(checkpoint.elements);
  const viewPath = path.resolve(boardFilePath(boardsDir, board, ".view.json", { maxDepth: maxDepthFromEnv() }));
  const view = {
    type: "xcld-view",
    source: "excalidraw-mcp",
    checkpointId,
    elements,
  };
  await mkdir(path.dirname(viewPath), { recursive: true });
  await writeFile(viewPath, `${JSON.stringify(view, null, 2)}\n`, "utf8");

  const url = `${publicUrl}/?board=${board.split("/").map(encodeURIComponent).join("/")}`;
  return {
    path: viewPath,
    url,
    checkpointId,
    board,
    elements: elements.length,
    reminder: "Open or keep open the canvas URL; an open tab converts this view inbox into the board.",
  };
};
