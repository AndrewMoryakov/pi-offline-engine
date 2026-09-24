#!/usr/bin/env node
// Loads extensions/pi-lean-edit.ts next to a fixture that also registers
// `edit` (as pi-utils does), through the installed pi runtime, for each
// editProvider. gate:pi loads extensions/index.ts alone with --no-extensions,
// so it cannot see a clash with another package; this gate can.
//
//   lean:   pi must refuse the pair (proves this gate can fail)
//   none:   loads; only the fixture's edit
//   hybrid: loads; line_edit from pi-lean-edit.ts and the fixture's edit,
//           both active (the throwaway agent dir has no model, so
//           cloud-only leaves edit as is)
//   hybrid with scriptEditPolicy=never: edit registered but hidden, which
//           exercises setActiveTools from session_start in a real pi
//
// Runs against a throwaway agent dir, so neither the user's settings nor
// their engine config can change the outcome.
//
// Spec: docs/HYBRID_EDIT_V0.md HE-9; the lean case reproduces HE-1; the
// schema checks cover HE-11.
import fs from "node:fs";
import os from "node:os";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extensionErrors, notifications, runPiRpc } from "./lib/pi-rpc.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = "./fixtures/pi-extensions/other-edit.ts";
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-edit-gate-"));

async function load(env) {
  const result = await runPiRpc({
    cwd: repoRoot,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, ...env },
    args: [
      "--no-session",
      "--no-extensions",
      "-e", "./extensions/pi-lean-edit.ts",
      "-e", fixture,
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files"
    ],
    requests: [{ type: "prompt", message: "/probe-edit-tools" }],
    until: (events) => probeOf(events) !== null,
    timeoutMs: 60_000
  });
  const errors = extensionErrors(result.events).map((e) => String(e.error ?? ""));
  if (/conflicts with/.test(result.stderr)) errors.push(result.stderr.trim());
  return { probe: probeOf(result.events), errors, result };
}

function probeOf(events) {
  const note = notifications(events).find((n) => n.message.startsWith("PROBE "));
  return note ? JSON.parse(note.message.slice("PROBE ".length)) : null;
}

const failures = [];
const expect = (label, condition, detail) => {
  process.stdout.write(`${condition ? "ok  " : "FAIL"} ${label}\n`);
  if (!condition) failures.push(`${label}: ${detail}`);
};
const owner = (probe, name) => probe?.all.find((tool) => tool.name === name)?.source ?? "";

const lean = await load({ PI_OFFLINE_EDIT_PROVIDER: "lean" });
expect("lean: pi refuses a second edit", lean.errors.some((e) => /Tool "edit" conflicts/.test(e)),
  `no conflict reported; errors=${JSON.stringify(lean.errors)} exit=${lean.result.exitCode}`);

const none = await load({ PI_OFFLINE_EDIT_PROVIDER: "none" });
expect("none: loads without errors", none.errors.length === 0 && none.probe !== null, JSON.stringify(none.errors));
expect("none: edit is the fixture's", owner(none.probe, "edit").endsWith("other-edit.ts"), owner(none.probe, "edit"));
expect("none: no line_edit", !owner(none.probe, "line_edit"), owner(none.probe, "line_edit"));

const hybrid = await load({ PI_OFFLINE_EDIT_PROVIDER: "hybrid", PI_OFFLINE_SCRIPT_EDIT_POLICY: "cloud-only" });
expect("hybrid: loads without errors", hybrid.errors.length === 0 && hybrid.probe !== null, JSON.stringify(hybrid.errors));
expect("hybrid: line_edit from pi-lean-edit.ts", owner(hybrid.probe, "line_edit").endsWith("pi-lean-edit.ts"), owner(hybrid.probe, "line_edit"));
expect("hybrid: edit from the fixture", owner(hybrid.probe, "edit").endsWith("other-edit.ts"), owner(hybrid.probe, "edit"));
expect("hybrid: both active", ["line_edit", "edit"].every((n) => hybrid.probe?.active.includes(n)), JSON.stringify(hybrid.probe?.active));

// HE-11: whatever name pi-lean-edit's edit ends up under, the model must get
// a schema with top-level properties, or ik_llama.cpp drops its arguments.
const flatIn = (probe, name) => Boolean(probe?.all.find((tool) => tool.name === name && tool.source.endsWith("pi-lean-edit.ts") && !tool.topLevelUnion));
expect("hybrid: line_edit schema is flat", flatIn(hybrid.probe, "line_edit"), JSON.stringify(hybrid.probe?.all.find((t) => t.name === "line_edit")));
const leanAlone = await load({ PI_OFFLINE_EDIT_PROVIDER: "lean", GATE_FIXTURE_NO_EDIT: "1" });
expect("lean alone: loads without errors", leanAlone.errors.length === 0 && leanAlone.probe !== null, JSON.stringify(leanAlone.errors));
expect("lean alone: edit is pi-lean-edit's, with a flat schema", flatIn(leanAlone.probe, "edit"), JSON.stringify(leanAlone.probe?.all.find((t) => t.name === "edit")));

const never = await load({ PI_OFFLINE_EDIT_PROVIDER: "hybrid", PI_OFFLINE_SCRIPT_EDIT_POLICY: "never" });
expect("hybrid+never: loads without errors", never.errors.length === 0 && never.probe !== null, JSON.stringify(never.errors));
expect("hybrid+never: edit registered but not active",
  Boolean(owner(never.probe, "edit")) && !never.probe?.active.includes("edit") && never.probe?.active.includes("line_edit"),
  JSON.stringify(never.probe?.active));

fs.rmSync(agentDir, { recursive: true, force: true });

if (failures.length > 0) {
  process.stderr.write(`EDIT CONFLICT GATE: FAIL\n${failures.map((f) => `  ${f}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("EDIT CONFLICT GATE: PASS\n");
