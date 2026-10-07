import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { boardFilePath, maxDepthFromEnv, splitBoardPath, validateBoardPath } from "./board-path.mjs";
import {
  ARROWHEADS,
  CHANGE_TYPES,
  CROSS_TARGETS,
  ELEMENT_TYPES,
  EXPORT_MODES,
  LEGACY_ARROWHEADS,
  MATCH_PROPS,
  PALETTE_COLORS,
  RULE_KINDS,
  SNAPSHOT_MODES,
  allowedValuesForProp,
} from "./rules-vocab.mjs";

const REQUIRED_COLUMNS = ["kind", "rule_id", "on", "match", "means", "instruct"];
const COMMENT_PREFIX = "#";
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const VALID_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const slash = (value) => String(value).replace(/\\/g, "/");
const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const short = (value) => String(value ?? "").slice(0, 10);
const center = (element) => ({ x: Number(element?.x ?? 0) + Number(element?.width ?? 0) / 2, y: Number(element?.y ?? 0) + Number(element?.height ?? 0) / 2 });
const bbox = (element) => ({
  left: Number(element?.x ?? 0),
  top: Number(element?.y ?? 0),
  right: Number(element?.x ?? 0) + Number(element?.width ?? 0),
  bottom: Number(element?.y ?? 0) + Number(element?.height ?? 0),
});

const levenshtein = (a, b) => {
  const prev = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let last = i - 1;
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const old = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = old;
    }
  }
  return prev[b.length];
};

const suggestion = (value, choices) => {
  const needle = String(value ?? "").toLowerCase();
  let best = null;
  let bestScore = Infinity;
  for (const choice of choices) {
    const score = levenshtein(needle, String(choice).toLowerCase());
    if (score < bestScore) {
      best = choice;
      bestScore = score;
    }
  }
  return best && bestScore <= Math.max(2, Math.floor(String(best).length / 3)) ? ` Did you mean "${best}"?` : "";
};

const diagnostic = (severity, file, line, message) => ({ severity, file, line, message: `${slash(file)}:${line}: ${message}` });

const parseCsvLine = (line, file, lineNumber) => {
  const fields = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"') {
      if (current.trim() !== "") {
        throw new Error(`${slash(file)}:${lineNumber}: quote must start a CSV field`);
      }
      quoted = true;
    } else if (char === ",") {
      fields.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (quoted) {
    throw new Error(`${slash(file)}:${lineNumber}: unterminated quoted CSV field`);
  }
  fields.push(current.trim());
  return fields;
};

export const parseRulesCsv = (text, file = "design-rules.csv") => {
  const records = [];
  const errors = [];
  let header = null;
  let headerLine = 0;
  const lines = String(text ?? "").replace(/^\uFEFF/, "").split(/\r\n|\n|\r/);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(COMMENT_PREFIX)) {
      continue;
    }
    let fields;
    try {
      fields = parseCsvLine(line, file, lineNumber);
    } catch (error) {
      errors.push(diagnostic("error", file, lineNumber, error.message.replace(`${slash(file)}:${lineNumber}: `, "")));
      continue;
    }
    if (!header) {
      header = fields.map((field) => field.replace(/^\uFEFF/, ""));
      headerLine = lineNumber;
      const missing = REQUIRED_COLUMNS.filter((column) => !header.includes(column));
      if (missing.length) {
        errors.push(diagnostic("error", file, lineNumber, `missing required column(s): ${missing.join(", ")}`));
      }
      continue;
    }
    const values = Object.fromEntries(header.map((column, fieldIndex) => [column, fields[fieldIndex] ?? ""]));
    records.push({ ...values, file, line: lineNumber, row: records.length + 1 });
  }
  if (!header) {
    errors.push(diagnostic("error", file, 1, "missing CSV header kind,rule_id,on,match,means,instruct"));
  } else if (header.length !== REQUIRED_COLUMNS.length || REQUIRED_COLUMNS.some((column, index) => header[index] !== column)) {
    errors.push(diagnostic("error", file, headerLine, `header should be exactly: ${REQUIRED_COLUMNS.join(",")}`));
  }
  return { records, errors };
};

const normalizePropValue = (prop, value, file, line) => {
  const raw = String(value ?? "").trim();
  if (raw === "*") return "*";
  if (prop === "strokeColor" || prop === "backgroundColor") {
    if (!HEX_COLOR.test(raw)) throw new Error(`unknown ${prop} value "${raw}"; use exact #rrggbb hex.${suggestion(raw, PALETTE_COLORS)}`);
    return raw.toLowerCase();
  }
  if (prop === "opacity") {
    if (!/^\d+$/.test(raw) || Number(raw) < 0 || Number(raw) > 100) throw new Error(`unknown opacity value "${raw}"; use 0-100`);
    return String(Number(raw));
  }
  if (prop === "frame") {
    if (!raw) throw new Error("frame value cannot be empty");
    return raw;
  }
  if (prop === "crosses") {
    if (CROSS_TARGETS.includes(raw) || VALID_ID.test(raw)) return raw;
    throw new Error(`unknown crosses target "${raw}"${suggestion(raw, CROSS_TARGETS)}`);
  }
  const allowed = allowedValuesForProp(prop);
  if (allowed && allowed.includes(raw)) return raw;
  if (allowed === ARROWHEADS && LEGACY_ARROWHEADS.includes(raw)) {
    throw new Error(`legacy ${prop} value "${raw}": Excalidraw renames it when it loads a board, so it never matches. Use one of: ${ARROWHEADS.join(", ")}`);
  }
  if (allowed) throw new Error(`unknown ${prop} value "${raw}"${suggestion(raw, allowed)}`);
  return raw;
};

const parsePredicate = (text, file, line) => {
  const source = String(text ?? "").trim();
  if (source === "*") return { any: true, source };
  const op = source.includes("!=") ? "!=" : source.includes("=") ? "=" : null;
  if (!op) throw new Error(`bad predicate "${source}"; use prop=value or prop!=value`);
  const [left, right] = source.split(op);
  const was = left.startsWith("was.");
  const prop = was ? left.slice(4) : left;
  if (!MATCH_PROPS.includes(prop)) {
    throw new Error(`unknown match property "${prop}"${suggestion(prop, MATCH_PROPS)}`);
  }
  if (right === "") throw new Error(`empty value for ${prop}`);
  const values = right.split("|").map((value) => normalizePropValue(prop, value, file, line));
  return { source, was, prop, op, values };
};

const parseMatch = (match, file, line) => {
  const text = String(match ?? "").trim();
  if (!text) return [];
  return text.split(";").map((part) => parsePredicate(part, file, line));
};

export const validateRules = (records, file = "design-rules.csv") => {
  const rules = [];
  const diagnostics = [];
  for (const record of records) {
    const line = record.line ?? 1;
    const kind = clean(record.kind);
    const id = clean(record.rule_id);
    const on = clean(record.on) || "";
    const means = clean(record.means);
    const instruct = clean(record.instruct);
    const rowErrors = [];
    if (!RULE_KINDS.includes(kind)) rowErrors.push(`unknown kind "${kind}"${suggestion(kind, RULE_KINDS)}`);
    if (!id) rowErrors.push("rule_id is required");
    if (kind === "interpret" && on && on !== "*" && !CHANGE_TYPES.includes(on)) rowErrors.push(`unknown on value "${on}"${suggestion(on, CHANGE_TYPES)}`);
    if (kind === "interpret" && !on) rowErrors.push("interpret rules require on (added, removed, relabeled, rewired, restyled, moved or *)");
    if (kind === "export" && means && !EXPORT_MODES.includes(means.toLowerCase())) rowErrors.push(`unknown export mode "${means}"; use off, snapshot or save`);
    if (kind === "snapshot" && means && !SNAPSHOT_MODES.includes(means.toLowerCase())) rowErrors.push(`unknown snapshot mode "${means}"; use on or off`);
    let predicates = [];
    try {
      predicates = parseMatch(record.match, record.file ?? file, line);
    } catch (error) {
      rowErrors.push(error.message);
    }
    for (const message of rowErrors) diagnostics.push(diagnostic("error", record.file ?? file, line, `${id || "<missing rule_id>"}: ${message}`));
    if (!rowErrors.length) {
      const rule = { kind, id, on, predicates, means, instruct, file: record.file ?? file, line, row: record.row ?? rules.length + 1 };
      rules.push(rule);
      if (kind === "protect") diagnostics.push(diagnostic("warning", rule.file, line, `${id}: protect is not enforced yet (deferred until versions/merge)`));
    }
  }
  return { rules, diagnostics };
};

// Rules files print relative to the boards root (`examples/design-rules.csv`); a file outside it
// (an XCLD_DESIGN_RULES path elsewhere) keeps its full path.
export const rulesFileLabel = (file, boardsDir) => {
  const relative = path.relative(path.resolve(boardsDir), path.resolve(file));
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? slash(relative) : slash(file);
};

const defaultRulesPath = (root, env = process.env) => env.XCLD_DESIGN_RULES ? path.resolve(env.XCLD_DESIGN_RULES) : path.join(root, "design-rules.csv");

export const ruleFileCandidates = (boardsDir, board, env = process.env) => {
  const root = path.resolve(boardsDir);
  const candidates = [{ file: defaultRulesPath(root, env), default: true }];
  if (board && validateBoardPath(board, { maxDepth: maxDepthFromEnv(env) }).ok) {
    const segments = splitBoardPath(board).slice(0, -1);
    for (let index = 1; index <= segments.length; index += 1) {
      candidates.push({ file: path.join(root, ...segments.slice(0, index), "design-rules.csv"), default: false });
    }
  }
  return candidates;
};

export const discoverRuleFiles = async (boardsDir, env = process.env) => {
  const root = path.resolve(boardsDir);
  const seen = new Set();
  const files = [];
  const add = (file, required = false) => {
    const resolved = path.resolve(file);
    if (!seen.has(resolved) && (required || existsSync(resolved))) {
      seen.add(resolved);
      files.push(resolved);
    }
  };
  add(defaultRulesPath(root, env), Boolean(env.XCLD_DESIGN_RULES));
  const visit = async (folder) => {
    let entries;
    try { entries = await readdir(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const child = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        await visit(child);
      } else if (entry.isFile() && entry.name === "design-rules.csv") {
        add(child);
      }
    }
  };
  await visit(root);
  return files;
};

const loadRuleFile = async (file, { required = false, root } = {}) => {
  const label = root ? rulesFileLabel(file, root) : file;
  try {
    const text = await readFile(file, "utf8");
    const parsed = parseRulesCsv(text, label);
    const validated = validateRules(parsed.records, label);
    return { file, label, exists: true, rules: validated.rules, diagnostics: [...parsed.errors, ...validated.diagnostics] };
  } catch (error) {
    if (!required && error?.code === "ENOENT") return { file, label, exists: false, rules: [], diagnostics: [] };
    return { file, label, exists: false, rules: [], diagnostics: [diagnostic("error", label, 1, error?.code === "ENOENT" ? "rules file not found" : error.message)] };
  }
};

export const loadEffectiveRulesForBoard = async (board, boardsDir = process.env.XCLD_BOARDS_DIR || path.resolve("boards"), env = process.env) => {
  const root = path.resolve(boardsDir);
  const candidates = ruleFileCandidates(root, board, env);
  const loaded = [];
  for (const candidate of candidates) loaded.push(await loadRuleFile(candidate.file, { required: candidate.default && Boolean(env.XCLD_DESIGN_RULES), root }));
  const existing = loaded.filter((item) => item.exists || item.diagnostics.length);
  const effective = [...loaded].reverse().find((item) => item.exists || item.diagnostics.some((d) => d.severity === "error")) ?? { rules: [], file: null, diagnostics: [] };
  return {
    board,
    boardsDir: root,
    files: existing,
    effectiveFile: effective.exists ? effective.file : null,
    effectiveLabel: effective.exists ? effective.label : null,
    rules: effective.exists ? effective.rules : [],
    diagnostics: existing.flatMap((item) => item.diagnostics),
  };
};

export const validateApplicableRules = async (board, boardsDir = process.env.XCLD_BOARDS_DIR || path.resolve("boards"), env = process.env) => {
  if (board) return loadEffectiveRulesForBoard(board, boardsDir, env);
  const files = await discoverRuleFiles(boardsDir, env);
  const loaded = [];
  for (const file of files) loaded.push(await loadRuleFile(file, { required: path.resolve(file) === path.resolve(defaultRulesPath(path.resolve(boardsDir), env)) && Boolean(env.XCLD_DESIGN_RULES), root: boardsDir }));
  return { board: null, boardsDir: path.resolve(boardsDir), files: loaded, rules: loaded.flatMap((item) => item.rules), diagnostics: loaded.flatMap((item) => item.diagnostics) };
};

const elementLabel = (element) => clean(element?.originalText ?? element?.text ?? element?.id);
const isLive = (element) => element && !element.isDeleted;
const isNote = (element) => element?.type === "text" && !element?.containerId;

const frameNameFor = (element, allElements) => {
  if (element?.frameId) {
    const frame = allElements.find((item) => item.id === element.frameId);
    return elementLabel(frame) || short(element.frameId);
  }
  if (element?.type === "frame") return elementLabel(element) || short(element.id);
  const point = center(element);
  const frame = allElements.find((item) => isLive(item) && item.type === "frame" && item.id !== element.id && point.x >= bbox(item).left && point.x <= bbox(item).right && point.y >= bbox(item).top && point.y <= bbox(item).bottom);
  return frame ? (elementLabel(frame) || short(frame.id)) : "";
};

const propValue = (element, prop, allElements = []) => {
  if (!element) return undefined;
  if (prop === "type") return element.type;
  if (prop === "strokeColor" || prop === "backgroundColor") return element[prop] ? String(element[prop]).toLowerCase() : undefined;
  if (prop === "strokeStyle" || prop === "fillStyle") return element[prop] ?? undefined;
  if (prop === "roundness") return element.roundness ? "round" : "sharp";
  if (prop === "strokeWidth" || prop === "opacity") return element[prop] === undefined || element[prop] === null ? undefined : String(element[prop]);
  if (prop === "startArrowhead" || prop === "endArrowhead") return element[prop] ?? "none";
  if (prop === "elbowed") return String(Boolean(element.elbowed));
  if (prop === "bound") return String(Boolean(element.containerId || element.startBinding?.elementId || element.endBinding?.elementId));
  if (prop === "frame") return frameNameFor(element, allElements);
  if (prop === "crosses") return undefined;
  return element[prop];
};

const pointsFor = (element) => {
  const baseX = Number(element?.x ?? 0);
  const baseY = Number(element?.y ?? 0);
  const raw = Array.isArray(element?.points) && element.points.length ? element.points : [[0, 0], [Number(element?.width ?? 0), Number(element?.height ?? 0)]];
  return raw.map((point) => ({ x: baseX + Number(point[0] ?? 0), y: baseY + Number(point[1] ?? 0) }));
};

const orientation = (a, b, c) => {
  const value = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  if (Math.abs(value) < 1e-9) return 0;
  return value > 0 ? 1 : 2;
};
const onSegment = (a, b, c) => b.x <= Math.max(a.x, c.x) && b.x >= Math.min(a.x, c.x) && b.y <= Math.max(a.y, c.y) && b.y >= Math.min(a.y, c.y);
const segmentsIntersect = (p1, q1, p2, q2) => {
  const o1 = orientation(p1, q1, p2);
  const o2 = orientation(p1, q1, q2);
  const o3 = orientation(p2, q2, p1);
  const o4 = orientation(p2, q2, q1);
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && onSegment(p1, p2, q1)) || (o2 === 0 && onSegment(p1, q2, q1)) || (o3 === 0 && onSegment(p2, p1, q2)) || (o4 === 0 && onSegment(p2, q1, q2));
};

const segmentIntersectsBox = (a, b, box) => {
  if (a.x >= box.left && a.x <= box.right && a.y >= box.top && a.y <= box.bottom) return true;
  if (b.x >= box.left && b.x <= box.right && b.y >= box.top && b.y <= box.bottom) return true;
  const tl = { x: box.left, y: box.top };
  const tr = { x: box.right, y: box.top };
  const br = { x: box.right, y: box.bottom };
  const bl = { x: box.left, y: box.bottom };
  return segmentsIntersect(a, b, tl, tr) || segmentsIntersect(a, b, tr, br) || segmentsIntersect(a, b, br, bl) || segmentsIntersect(a, b, bl, tl);
};

export const elementCrossesTarget = (element, target, allElements) => {
  if (!["line", "arrow", "freedraw"].includes(element?.type)) return false;
  const points = pointsFor(element);
  if (points.length < 2) return false;
  const candidates = allElements.filter((item) => {
    if (!isLive(item) || item.id === element.id) return false;
    if (target === "note" || target === "text") return isNote(item);
    if (MATCH_PROPS.includes(target)) return false;
    if (ELEMENT_TYPES.includes(target)) return item.type === target;
    return item.id === target || elementLabel(item) === target;
  });
  for (const candidate of candidates) {
    const box = bbox(candidate);
    for (let index = 1; index < points.length; index += 1) {
      if (segmentIntersectsBox(points[index - 1], points[index], box)) return true;
    }
  }
  return false;
};

export const isElementCrossed = (targetElement, allElements) => allElements.some((element) => elementCrossesTarget(element, targetElement?.id, allElements));

const predicateMatches = (predicate, before, after, allElements) => {
  if (predicate.any) return true;
  if (predicate.prop === "crosses") {
    const element = predicate.was ? before : after;
    const matched = predicate.values.some((target) => target === "*" || elementCrossesTarget(element, target, allElements));
    return predicate.op === "!=" ? !matched : matched;
  }
  const element = predicate.was ? before : after;
  const actual = propValue(element, predicate.prop, allElements);
  const matched = predicate.values.includes("*") ? actual !== undefined && actual !== "" : predicate.values.includes(String(actual));
  return predicate.op === "!=" ? !matched : matched;
};

export const rulesForChange = (rules, { changeType, before, after, allElements = [] }) => rules
  .filter((rule) => rule.kind === "interpret" && (rule.on === "*" || rule.on === changeType))
  .filter((rule) => rule.predicates.every((predicate) => predicateMatches(predicate, before, after, allElements)))
  .map((rule) => ({ id: rule.id, means: rule.means, instruct: rule.instruct, scope: slash(rule.file) }));

export const ruleTagText = (rules) => rules?.length ? `  ${rules.map((rule) => `[${rule.id} → ${rule.means}]`).join(" ")}` : "";

export const collectRuleLegend = (diff) => {
  const seen = new Set();
  const legend = [];
  const arrays = [diff.nodes?.added, diff.nodes?.removed, diff.nodes?.relabeled, diff.edges?.added, diff.edges?.removed, diff.edges?.rewired, diff.edges?.relabeled, diff.notes?.added, diff.notes?.removed, diff.notes?.changed, diff.styles, diff.moves];
  for (const array of arrays) {
    for (const item of array ?? []) {
      for (const rule of item.rules ?? []) {
        if (seen.has(rule.id)) continue;
        seen.add(rule.id);
        legend.push(rule);
      }
    }
  }
  return legend;
};

export const formatRuleWarnings = (diagnostics) => {
  const errors = (diagnostics ?? []).filter((item) => item.severity === "error");
  if (!errors.length) return "";
  return ["WARNING: invalid design rules were skipped:", ...errors.map((item) => `  - ${item.message}`)].join("\n");
};

export const formatRulesCheckDiagnostics = (diagnostics) => (diagnostics ?? []).map((item) => `${item.severity.toUpperCase()}: ${item.message}`).join("\n");

export const effectiveRulesBriefing = async (board, boardsDir = process.env.XCLD_BOARDS_DIR || path.resolve("boards"), env = process.env) => {
  const loaded = await loadEffectiveRulesForBoard(board, boardsDir, env);
  return { ...loaded, text: formatBriefing(loaded) };
};

export const formatBriefing = (loaded) => {
  const lines = [`Design rules for ${loaded.board ?? "boards"}: local defaults only; any folder can replace them with its own design-rules.csv.`];
  if (!loaded.effectiveFile) {
    lines.push("No design-rules.csv applies; use free-form interpretation.");
  } else {
    lines.push(`Effective file: ${loaded.effectiveLabel ?? slash(loaded.effectiveFile)}`);
    const sections = [
      ["Draw", loaded.rules.filter((rule) => rule.kind === "draw")],
      ["Interpret", loaded.rules.filter((rule) => rule.kind === "interpret")],
      ["Check", loaded.rules.filter((rule) => rule.kind === "check")],
    ];
    for (const [title, rules] of sections) {
      if (!rules.length) continue;
      lines.push(`${title}:`);
      for (const rule of rules) {
        const condition = rule.predicates.length ? ` when ${rule.predicates.map((p) => p.source).join("; ")}` : "";
        const on = rule.kind === "interpret" ? ` on ${rule.on}` : "";
        lines.push(`  - ${rule.id}${on}${condition}: ${rule.means}${rule.instruct ? ` — ${rule.instruct}` : ""} (${slash(rule.file)})`);
      }
    }
  }
  const warnings = (loaded.diagnostics ?? []).filter((item) => item.severity === "warning");
  for (const warning of warnings) lines.push(`NOTICE: ${warning.message}`);
  const warningText = formatRuleWarnings(loaded.diagnostics);
  if (warningText) lines.push(warningText);
  return lines.join("\n");
};

export const effectiveExportMode = async (board, boardsDir, fallbackMode = "snapshot", env = process.env) => {
  const loaded = await loadEffectiveRulesForBoard(board, boardsDir, env);
  const rule = [...loaded.rules].reverse().find((item) => item.kind === "export" && EXPORT_MODES.includes(item.means.toLowerCase()));
  return rule ? rule.means.toLowerCase() : fallbackMode;
};

export const effectiveSnapshotMode = async (board, boardsDir, env = process.env) => {
  const loaded = await loadEffectiveRulesForBoard(board, boardsDir, env);
  const rule = [...loaded.rules].reverse().find((item) => item.kind === "snapshot" && SNAPSHOT_MODES.includes(item.means.toLowerCase()));
  return rule ? rule.means.toLowerCase() : "off";
};

export const checkBoardRules = async (board, boardsDir = process.env.XCLD_BOARDS_DIR || path.resolve("boards"), env = process.env) => {
  if (!validateBoardPath(board, { maxDepth: maxDepthFromEnv(env) }).ok) throw new Error(`Invalid board name: ${board}`);
  const root = path.resolve(boardsDir);
  const file = path.resolve(boardFilePath(root, board, ".excalidraw", { maxDepth: maxDepthFromEnv(env) }));
  const text = await readFile(file, "utf8");
  const scene = JSON.parse(text);
  const elements = Array.isArray(scene.elements) ? scene.elements.filter((element) => !element.isDeleted) : [];
  const loaded = await loadEffectiveRulesForBoard(board, root, env);
  const open = [];
  for (const rule of loaded.rules.filter((item) => item.kind === "check")) {
    const explicitlyChecksText = rule.predicates.some((predicate) => predicate.prop === "type" && predicate.values.includes("text"));
    for (const element of elements) {
      if (element.type === "text" && element.containerId && !explicitlyChecksText) continue;
      if (!rule.predicates.every((predicate) => predicateMatches(predicate, null, element, elements))) continue;
      if (isNote(element) && isElementCrossed(element, elements)) continue;
      open.push({ rule: rule.id, means: rule.means, instruct: rule.instruct, scope: slash(rule.file), id: element.id, type: element.type, label: elementLabel(element) || short(element.id) });
    }
  }
  return { board, file, open, labelWarnings: literalBreakLabels(elements), diagnostics: loaded.diagnostics, rulesFile: loaded.effectiveLabel };
};

// mermaid-to-excalidraw copies <br>/<br/> into the label verbatim; only a real newline inside
// the quoted Mermaid label becomes a line break. originalText is the label before wrapping.
export const literalBreakLabels = (elements) => (elements ?? [])
  .filter((element) => element && !element.isDeleted && element.type === "text" && /<br/i.test(String(element.originalText ?? "")))
  .map((element) => {
    const container = element.containerId ? elements.find((item) => item.id === element.containerId) : null;
    return { id: element.id, label: clean(element.originalText), container: container ? { id: container.id, type: container.type } : null };
  });

export const formatLabelWarnings = (labelWarnings) => {
  if (!labelWarnings?.length) return "";
  return [
    "WARNING: literal <br> in label text; the canvas shows the tag, not a line break. In Mermaid, put a real newline inside the quoted label instead of <br/>:",
    ...labelWarnings.map((item) => `  - "${item.label}" (text ${item.id}${item.container ? ` in ${item.container.type} ${item.container.id}` : ""})`),
  ].join("\n");
};

export const formatCheckResult = (result) => {
  const lines = [];
  const warningText = formatRuleWarnings(result.diagnostics);
  if (warningText) lines.push(warningText, "");
  const labelText = formatLabelWarnings(result.labelWarnings);
  if (labelText) lines.push(labelText, "");
  if (!result.open.length) {
    lines.push(`Design check passed for ${result.board}: no open items.`);
  } else {
    lines.push(`Design check found ${result.open.length} open item${result.open.length === 1 ? "" : "s"} for ${result.board}:`);
    for (const item of result.open) lines.push(`  - ${item.means}: ${item.label} (${item.type} ${item.id}) [${item.rule}]`);
  }
  return lines.join("\n");
};
