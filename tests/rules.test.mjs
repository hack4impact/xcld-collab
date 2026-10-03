import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import path from "node:path";
import { createBoardApi } from "../app/server/api.mjs";
import { diffFiles, formatDiff } from "../tools/diff.mjs";
import { snapshotBoard } from "../tools/snapshot.mjs";
import { checkBoardRules, elementCrossesTarget, effectiveRulesBriefing, parseRulesCsv, validateRules } from "../tools/rules.mjs";

const rootDir = path.resolve(".");
const fixture = () => readFile(path.resolve("tests", "fixtures", "demo-converted.excalidraw"), "utf8");
const tempRoot = async (name) => {
  const root = path.resolve(".test-run", `${name}-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  return root;
};
const scene = (elements) => `${JSON.stringify({ type: "excalidraw", elements, appState: {}, files: {} })}\n`;
const box = (id, label, props = {}) => ([
  { id, type: "rectangle", x: props.x ?? 10, y: props.y ?? 10, width: props.width ?? 120, height: props.height ?? 60, strokeColor: props.strokeColor ?? "#1e1e1e", backgroundColor: props.backgroundColor ?? "transparent", strokeStyle: props.strokeStyle ?? "solid", strokeWidth: props.strokeWidth ?? 2, fillStyle: props.fillStyle ?? "hachure", opacity: props.opacity ?? 100, isDeleted: false },
  { id: `${id}_label`, type: "text", x: (props.x ?? 10) + 10, y: (props.y ?? 10) + 10, width: 80, height: 24, strokeColor: "#1e1e1e", backgroundColor: "transparent", strokeStyle: "solid", strokeWidth: 2, text: label, originalText: label, containerId: id, isDeleted: false },
]);
const note = (id, text, props = {}) => ({ id, type: "text", x: props.x ?? 30, y: props.y ?? 100, width: props.width ?? 100, height: props.height ?? 30, strokeColor: props.strokeColor ?? "#1e1e1e", backgroundColor: "transparent", strokeStyle: "solid", strokeWidth: 2, text, originalText: text, isDeleted: false });
const line = (id, props = {}) => ({ id, type: props.type ?? "line", x: props.x ?? 20, y: props.y ?? 115, width: props.width ?? 140, height: props.height ?? 0, points: props.points ?? [[0, 0], [140, 0]], strokeColor: "#1e1e1e", backgroundColor: "transparent", strokeStyle: props.strokeStyle ?? "solid", strokeWidth: 2, isDeleted: false });
const arrow = (id, props = {}) => ({ ...line(id, { ...props, type: "arrow" }), startArrowhead: props.startArrowhead ?? null, endArrowhead: props.endArrowhead ?? "arrow", startBinding: props.startBinding, endBinding: props.endBinding });

const runCli = (args, boardsDir, env = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["tools/cli.mjs", ...args], { cwd: rootDir, env: { ...process.env, XCLD_BOARDS_DIR: boardsDir, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", reject);
  child.on("close", (code) => resolve({ code, stdout, stderr }));
});

const withApi = async (options, fn) => {
  const boardsDir = await tempRoot("rules-api");
  const api = createBoardApi({ boardsDir, pollMs: 100, useFsWatch: false, ...options });
  const server = createServer((req, res) => { void api.handle(req, res); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    await fn({ boardsDir, base: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` });
  } finally {
    api.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await rm(boardsDir, { recursive: true, force: true });
  }
};

const waitFor = async (check, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
};

test("rules CSV handles BOM, comments, quoted commas, CRLF, and deferred protect", () => {
  const text = "\uFEFF# local defaults\r\nkind,rule_id,on,match,means,instruct\r\ninterpret,note,added,type=text,note,\"hello, agent\"\r\nprotect,approved-locked,,strokeColor=#1E1E1E,approved,locked\r\n";
  const parsed = parseRulesCsv(text, "rules.csv");
  assert.deepEqual(parsed.errors, []);
  const validated = validateRules(parsed.records, "rules.csv");
  assert.equal(validated.rules.length, 2);
  assert.equal(validated.rules[0].instruct, "hello, agent");
  assert.equal(validated.rules[1].predicates[0].values[0], "#1e1e1e");
  assert.match(validated.diagnostics.find((item) => item.severity === "warning")?.message ?? "", /protect is not enforced yet/);
});

test("rules cascade uses nearest file and XCLD_DESIGN_RULES as the overridable default", async () => {
  const root = await tempRoot("rules-cascade");
  try {
    await writeFile(path.join(root, "design-rules.csv"), "kind,rule_id,on,match,means,instruct\ninterpret,root-note,added,type=text,root,root rule\n", "utf8");
    await mkdir(path.join(root, "sub"), { recursive: true });
    await writeFile(path.join(root, "sub", "design-rules.csv"), "kind,rule_id,on,match,means,instruct\ninterpret,sub-note,added,type=text,sub,sub rule\n", "utf8");
    assert.match((await effectiveRulesBriefing("rootboard", root)).text, /root-note/);
    const sub = await effectiveRulesBriefing("sub/board", root);
    assert.match(sub.text, /sub-note/);
    assert.doesNotMatch(sub.text, /root-note/);

    const envFile = path.join(root, "override.csv");
    await writeFile(envFile, "kind,rule_id,on,match,means,instruct\ninterpret,env-note,added,type=text,env,env rule\n", "utf8");
    const env = { ...process.env, XCLD_DESIGN_RULES: envFile };
    assert.match((await effectiveRulesBriefing("rootboard", root, env)).text, /env-note/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("diff rules cover operators, was transitions, removed before-state, crosses, JSON rules, warning skip and legend dedupe", async () => {
  const root = await tempRoot("rules-diff");
  try {
    await writeFile(path.join(root, "design-rules.csv"), [
      "kind,rule_id,on,match,means,instruct",
      "interpret,approve,restyled,was.strokeColor=#1971c2;strokeColor=#1e1e1e,approved,keep it",
      "interpret,reject,removed,was.strokeColor=#1971c2,rejected,do not re-add",
      "interpret,note,added,type=text;bound=false,note,read it",
      "interpret,optional,*,strokeStyle=dashed|dotted,optional,keep dashed",
      "interpret,not-red,restyled,was.strokeColor!=#e03131;strokeColor=#1e1e1e,not red,not from red",
      "interpret,strike,added,type=line;crosses=note,resolved note,line crosses note",
      "interpret,bad,added,strokeColour=#fff,bad,skip me",
    ].join("\n"), "utf8");
    await writeFile(path.join(root, "before.excalidraw"), scene([
      ...box("approved", "Approve me", { strokeColor: "#1971c2" }),
      ...box("red", "Was red", { strokeColor: "#e03131", x: 200 }),
      ...box("removed", "Rejected", { strokeColor: "#1971c2", x: 400 }),
      arrow("old_dashed", { strokeStyle: "dashed", x: 10, y: 250 }),
    ]), "utf8");
    await writeFile(path.join(root, "after.excalidraw"), scene([
      ...box("approved", "Approve me", { strokeColor: "#1e1e1e" }),
      ...box("red", "Was red", { strokeColor: "#1e1e1e", x: 200 }),
      arrow("old_dashed", { strokeStyle: "dotted", x: 10, y: 250 }),
      arrow("new_dashed", { strokeStyle: "dashed", x: 10, y: 300 }),
      note("n1", "please answer", { x: 50, y: 110 }),
      line("strike", { x: 40, y: 125, points: [[0, 0], [140, 0]] }),
    ]), "utf8");
    const diff = await diffFiles(path.join(root, "before.excalidraw"), path.join(root, "after.excalidraw"), { board: "after", boardsDir: root });
    const text = formatDiff(diff);
    assert.match(text, /^WARNING: invalid design rules were skipped:/);
    assert.match(text, /\[approve → approved\]/);
    assert.match(text, /\[reject → rejected\]/);
    assert.match(text, /\[strike → resolved note\]/);
    assert.equal(diff.styles.find((item) => item.id === "approved" && item.property === "strokeColor").rules.some((rule) => rule.id === "approve"), true);
    assert.equal(diff.styles.find((item) => item.id === "red" && item.property === "strokeColor").rules.some((rule) => rule.id === "approve"), false, "red → black must not fire was light-blue approve");
    assert.equal(diff.nodes.removed[0].rules[0].id, "reject");
    assert.equal(diff.notes.added[0].rules.some((rule) => rule.id === "note"), true);
    assert.equal((text.match(/\[optional → optional\] keep dashed/g) ?? []).length, 1, "legend should dedupe repeated rules");
    assert.equal(elementCrossesTarget(line("s", { x: 40, y: 125, points: [[0, 0], [140, 0]] }), "note", [note("n", "open", { x: 50, y: 110 }), line("s", { x: 40, y: 125, points: [[0, 0], [140, 0]] })]), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rules check returns precise failures and protect warnings without failing", async () => {
  const root = await tempRoot("rules-check");
  try {
    await writeFile(path.join(root, "design-rules.csv"), "kind,rule_id,on,match,means,instruct\ninterpet,bad,added,strokeColour=#fff,bad,bad\n", "utf8");
    const bad = await runCli(["rules", "check", "board"], root);
    assert.equal(bad.code, 1);
    assert.match(bad.stdout, /ERROR: .*unknown kind "interpet"/);
    assert.match(bad.stdout, /Did you mean "interpret"/);
    assert.match(bad.stdout, /strokeColour/);

    await writeFile(path.join(root, "design-rules.csv"), "kind,rule_id,on,match,means,instruct\nprotect,approved-locked,,strokeColor=#1e1e1e,approved,locked\n", "utf8");
    const protect = await runCli(["rules", "check", "board"], root);
    assert.equal(protect.code, 0, protect.stderr);
    assert.match(protect.stdout, /protect is not enforced yet/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("xcld check reports open proposals and notes, then passes after resolution", async () => {
  const root = await tempRoot("rules-open");
  try {
    await writeFile(path.join(root, "design-rules.csv"), "kind,rule_id,on,match,means,instruct\ncheck,open-proposals,,strokeColor=#1971c2,open proposal,finish it\ncheck,open-notes,,type=text;bound=false,open note,cross or delete it\n", "utf8");
    await writeFile(path.join(root, "flow.excalidraw"), scene([...box("p", "Proposal", { strokeColor: "#1971c2" }), note("n", "unanswered", { x: 20, y: 100 })]), "utf8");
    const open = await runCli(["check", "flow"], root);
    assert.equal(open.code, 1);
    assert.match(open.stdout, /open proposal/);
    assert.match(open.stdout, /open note/);

    await writeFile(path.join(root, "flow.excalidraw"), scene([...box("p", "Proposal", { strokeColor: "#1e1e1e" }), note("n", "answered", { x: 20, y: 100 }), line("strike", { x: 10, y: 115, points: [[0, 0], [150, 0]] })]), "utf8");
    const done = await runCli(["check", "flow"], root);
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stdout, /Design check passed/);
    assert.equal((await checkBoardRules("flow", root)).open.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("export rules override XCLD_AUTO_EXPORT for snapshots and server saves", async () => {
  const root = await tempRoot("rules-export");
  try {
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(path.join(root, "docs", "design-rules.csv"), "kind,rule_id,on,match,means,instruct\nexport,export-mode,,,save,keep exports\n", "utf8");
    await writeFile(path.join(root, "docs", "flow.excalidraw"), await fixture(), "utf8");
    const snap = await snapshotBoard("docs/flow", root, { autoExport: "off" });
    assert.equal(snap.mermaid.endsWith(".mmd"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  await withApi({ autoExport: "off" }, async ({ boardsDir, base, host }) => {
    await mkdir(path.join(boardsDir, "docs"), { recursive: true });
    await writeFile(path.join(boardsDir, "docs", "design-rules.csv"), "kind,rule_id,on,match,means,instruct\nexport,export-mode,,,save,keep exports\n", "utf8");
    const put = await fetch(`${base}/api/board/docs/flow`, { method: "PUT", headers: { Host: host, "Content-Type": "application/json" }, body: await fixture() });
    assert.equal(put.status, 200);
    assert.equal(await waitFor(() => existsSync(path.join(boardsDir, ".exports", "docs", "flow.mmd"))), true);
  });
});
