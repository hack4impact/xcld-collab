import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import path from "node:path";
import { DEFAULT_OUT, generateVocabulary, inputsFor, pinnedExcalidrawSha, readTypeVocabulary } from "../scripts/gen-rules-vocab.mjs";
import { EXCALIDRAW_SHA } from "../tools/rules-vocab.generated.mjs";
import { rulesForChange, validateRules } from "../tools/rules.mjs";

const vendorInputs = inputsFor();
const vendorInstalled = existsSync(vendorInputs.typesFile) && existsSync(vendorInputs.commonEntry);
const rule = (match, extra = {}) => ({ kind: "interpret", rule_id: "r", on: "*", match, means: "m", instruct: "i", line: 2, ...extra });
const errorsFor = (match) => validateRules([rule(match)]).diagnostics.filter((item) => item.severity === "error").map((item) => item.message);

test("checked-in rules vocabulary matches the generator output for the pinned Excalidraw", {
  skip: !vendorInstalled && "Excalidraw vendor packages not installed (build.ps1 -Target vendor; cd app; npm install)",
}, async () => {
  const expected = await generateVocabulary();
  const actual = (await readFile(DEFAULT_OUT, "utf8")).replace(/\r\n/g, "\n");
  assert.equal(actual, expected, "tools/rules-vocab.generated.mjs is stale; run node scripts/gen-rules-vocab.mjs");
});

test("generated rules vocabulary records the Excalidraw SHA from pins.json", () => {
  assert.equal(EXCALIDRAW_SHA, pinnedExcalidrawSha());
});

test("rule values come from the generated vocabulary, with suggestions for typos", () => {
  assert.deepEqual(errorsFor("type=arrow;endArrowhead=bar"), []);
  assert.deepEqual(errorsFor("endArrowhead=none|cardinality_many;strokeWidth=8;type=stickynote;roundness=round"), []);
  assert.match(errorsFor("endArrowhead=barr")[0], /unknown endArrowhead value "barr" Did you mean "bar"\?/);
  assert.match(errorsFor("roundness=rounded")[0], /unknown roundness value "rounded" Did you mean "round"\?/);
  assert.match(errorsFor("strokeColor=#1971c")[0], /use exact #rrggbb hex\. Did you mean "#1971c2"\?/);
  assert.match(errorsFor("startArrowhead=crowfoot_many")[0], /legacy startArrowhead value "crowfoot_many": Excalidraw renames it/);
});

test("roundness matches rounded and sharp elements", () => {
  const { rules } = validateRules([rule("roundness=round", { rule_id: "rounded" }), rule("roundness=sharp", { rule_id: "sharp" })]);
  const ids = (element) => rulesForChange(rules, { changeType: "added", before: null, after: element }).map((item) => item.id);
  assert.deepEqual(ids({ id: "a", type: "rectangle", roundness: { type: 3 } }), ["rounded"]);
  assert.deepEqual(ids({ id: "b", type: "rectangle", roundness: null }), ["sharp"]);
});

test("the generator fails loudly when the types don't parse into string-literal unions", async () => {
  const root = path.resolve(".test-run", `vocab-${Date.now()}-${process.pid}`);
  await mkdir(root, { recursive: true });
  try {
    const typesFile = path.join(root, "types.ts");
    await writeFile(typesFile, 'export type StrokeStyle = "solid" | "dashed";\nexport type FillStyle = string;\n', "utf8");
    assert.throws(() => readTypeVocabulary(typesFile), /type ExcalidrawElementType not found/);
    await writeFile(typesFile, [
      'type Base = { id: string };',
      'export type ExcalidrawElement = Base & { type: "rectangle" } | Base & { type: "selection" };',
      "export type ExcalidrawElementType = ExcalidrawElement[\"type\"];",
      'export type StrokeStyle = "solid";',
      "export type FillStyle = string;",
    ].join("\n"), "utf8");
    assert.throws(() => readTypeVocabulary(typesFile), /type FillStyle in types\.ts is not a union of string literals: string/);
    assert.throws(() => readTypeVocabulary(path.join(root, "missing.ts")), /Excalidraw element types not found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
