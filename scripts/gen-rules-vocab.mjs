#!/usr/bin/env node
// Generate tools/rules-vocab.generated.mjs, the design-rules linter vocabulary, from the
// pinned Excalidraw build instead of hand-maintained lists.
//
//   node scripts/gen-rules-vocab.mjs            # from app/node_modules (build.ps1 -Target vendor; cd app; npm install)
//   node scripts/gen-rules-vocab.mjs --check    # exit 1 if the checked-in file is stale
//   node scripts/gen-rules-vocab.mjs --source /src/excalidraw --sha <sha> --out <file>
//                                               # inside the Docker build, from the checkout
//
// Inputs, both from the same Excalidraw commit:
//   - element types: packages/element/src/types.ts (or its emitted .d.ts in the vendor
//     package), read with the TypeScript type checker, so aliases and unions resolve exactly
//     as the compiler sees them;
//   - runtime constants: STROKE_WIDTH and COLOR_PALETTE from the built @excalidraw/common.
// Any missing type or constant, or a type that isn't a union of string literals, is an error.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_OUT = path.join(repoRoot, "tools", "rules-vocab.generated.mjs");
const APP_ELEMENT_TYPES = path.join(repoRoot, "app", "node_modules", "@excalidraw", "element", "dist", "types", "element", "src", "types.d.ts");
const APP_COMMON = path.join(repoRoot, "app", "node_modules", "@excalidraw", "common", "dist", "prod", "index.js");

// Transient editor state; never saved in a board, so never a useful rule value.
const EXCLUDED_ELEMENT_TYPES = new Set(["selection"]);

export const inputsFor = ({ source } = {}) => source
  ? {
      typesFile: path.join(source, "packages", "element", "src", "types.ts"),
      commonEntry: path.join(source, "packages", "common", "dist", "prod", "index.js"),
    }
  : { typesFile: APP_ELEMENT_TYPES, commonEntry: APP_COMMON };

export const pinnedExcalidrawSha = () => JSON.parse(readFileSync(path.join(repoRoot, "pins.json"), "utf8")).components.excalidraw.sha;

const stringLiteralUnion = (ts, checker, aliases, name, file) => {
  const node = aliases.get(name);
  if (!node) throw new Error(`type ${name} not found in ${file}`);
  const type = checker.getTypeAtLocation(node.name);
  const members = type.isUnion() ? type.types : [type];
  const values = members.map((member) => (member.isStringLiteral() ? member.value : null));
  if (!values.length || values.includes(null)) {
    throw new Error(`type ${name} in ${file} is not a union of string literals: ${checker.typeToString(type)}`);
  }
  return [...new Set(values)].sort();
};

// Resolve TypeScript next to the types (the Excalidraw checkout in Docker), else from app/.
const loadTypeScript = (typesFile) => {
  for (const base of [typesFile, path.join(repoRoot, "app", "package.json")]) {
    try {
      return createRequire(base)("typescript");
    } catch {}
  }
  throw new Error("typescript not found; run npm install in app/ (or yarn install in the Excalidraw checkout)");
};

export const readTypeVocabulary = (typesFile) => {
  if (!existsSync(typesFile)) throw new Error(`Excalidraw element types not found: ${typesFile}`);
  const ts = loadTypeScript(typesFile);
  const program = ts.createProgram([typesFile], { noEmit: true, skipLibCheck: true, strict: true, types: [] });
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(typesFile);
  const aliases = new Map(sourceFile.statements.filter(ts.isTypeAliasDeclaration).map((node) => [node.name.text, node]));
  const union = (name) => stringLiteralUnion(ts, checker, aliases, name, path.basename(typesFile));
  return {
    elementTypes: union("ExcalidrawElementType").filter((value) => !EXCLUDED_ELEMENT_TYPES.has(value)),
    strokeStyles: union("StrokeStyle"),
    fillStyles: union("FillStyle"),
    arrowheads: union("Arrowhead"),
    legacyArrowheads: union("ArrowheadLegacy"),
    roundness: union("StrokeRoundness"),
  };
};

const HEX = /^#[0-9a-f]{6}$/;

export const readConstants = async (commonEntry) => {
  if (!existsSync(commonEntry)) throw new Error(`@excalidraw/common build not found: ${commonEntry}`);
  const common = await import(pathToFileURL(commonEntry).href);
  const { STROKE_WIDTH, COLOR_PALETTE } = common;
  const widths = Object.values(STROKE_WIDTH ?? {});
  if (!widths.length || !widths.every((value) => Number.isInteger(value) && value > 0)) {
    throw new Error(`STROKE_WIDTH in ${commonEntry} is not a map of positive integers`);
  }
  if (!COLOR_PALETTE || typeof COLOR_PALETTE !== "object") throw new Error(`COLOR_PALETTE not exported by ${commonEntry}`);
  const palette = {};
  for (const [name, value] of Object.entries(COLOR_PALETTE)) {
    const shades = (Array.isArray(value) ? value : [value]).map((shade) => String(shade).toLowerCase());
    const hex = shades.filter((shade) => HEX.test(shade));
    if (hex.length !== shades.length && !(name === "transparent" && shades[0] === "transparent")) {
      throw new Error(`COLOR_PALETTE.${name} in ${commonEntry} has a non-hex value: ${shades.join(", ")}`);
    }
    if (hex.length) palette[name] = hex;
  }
  return { strokeWidths: [...new Set(widths)].sort((a, b) => a - b).map(String), palette };
};

const list = (values) => `[\n${values.map((value) => `  ${JSON.stringify(value)},`).join("\n")}\n]`;

export const renderVocabulary = ({ sha, types, constants }) => [
  "// GENERATED by scripts/gen-rules-vocab.mjs. Do not edit; regenerate instead.",
  `// Source: excalidraw/excalidraw@${sha}`,
  "//   packages/element/src/types.ts (ExcalidrawElementType minus \"selection\", StrokeStyle,",
  "//   FillStyle, Arrowhead, ArrowheadLegacy, StrokeRoundness) and @excalidraw/common",
  "//   (STROKE_WIDTH, COLOR_PALETTE).",
  `export const EXCALIDRAW_SHA = ${JSON.stringify(sha)};`,
  `export const ELEMENT_TYPES = ${list(types.elementTypes)};`,
  `export const STROKE_STYLES = ${list(types.strokeStyles)};`,
  `export const STROKE_WIDTHS = ${list(constants.strokeWidths)};`,
  `export const FILL_STYLES = ${list(types.fillStyles)};`,
  `export const ARROWHEADS = ${list(types.arrowheads)};`,
  `export const LEGACY_ARROWHEADS = ${list(types.legacyArrowheads)};`,
  `export const ROUNDNESS = ${list(types.roundness)};`,
  `export const PALETTE = {\n${Object.entries(constants.palette).map(([name, shades]) => `  ${name}: [${shades.map((shade) => JSON.stringify(shade)).join(", ")}],`).join("\n")}\n};`,
  "",
].join("\n");

export const generateVocabulary = async ({ source, sha = pinnedExcalidrawSha() } = {}) => {
  if (!/^[0-9a-f]{40}$/.test(String(sha))) throw new Error(`expected a 40-character Excalidraw commit SHA, got ${sha}`);
  const { typesFile, commonEntry } = inputsFor({ source });
  return renderVocabulary({ sha, types: readTypeVocabulary(typesFile), constants: await readConstants(commonEntry) });
};

const parseArgs = (argv) => {
  const options = { out: DEFAULT_OUT, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") options.check = true;
    else if (arg === "--source" || arg === "--sha" || arg === "--out") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} needs a value`);
      options[arg.slice(2)] = arg === "--sha" ? value : path.resolve(value);
      index += 1;
    } else throw new Error(`unknown argument ${arg}; usage: gen-rules-vocab.mjs [--source <excalidraw checkout>] [--sha <sha>] [--out <file>] [--check]`);
  }
  return options;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const text = await generateVocabulary(options);
    const current = existsSync(options.out) ? readFileSync(options.out, "utf8").replace(/\r\n/g, "\n") : null;
    if (options.check) {
      if (current !== text) {
        console.error(`${path.relative(repoRoot, options.out) || options.out} is stale; run: node scripts/gen-rules-vocab.mjs`);
        process.exitCode = 1;
      } else {
        console.log(`${path.relative(repoRoot, options.out)} is up to date.`);
      }
    } else {
      writeFileSync(options.out, text, "utf8");
      console.log(`${current === text ? "unchanged" : "wrote"} ${path.relative(repoRoot, options.out) || options.out}`);
    }
  } catch (error) {
    console.error(`gen-rules-vocab: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
