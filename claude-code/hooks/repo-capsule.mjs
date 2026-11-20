#!/usr/bin/env node
// Claude Code SessionStart hook: adds the deterministic repository snapshot
// (root, branch, HEAD, tracked changes, .sln/.csproj/global.json) that the Pi
// extension injects before agent runs. Disabled by PI_OFFLINE_REPO_CAPSULE=0.
// Outside a git work tree, or on any error, it prints nothing.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { buildRepoCapsule } from "../../src/repo-capsule.mjs";
import { nodeExec } from "../../src/node-exec.mjs";
import { appendEvent } from "../../src/event-log.mjs";

export async function capsuleHookPayload(payload, { env = process.env, exec = nodeExec } = {}) {
  if (env.PI_OFFLINE_REPO_CAPSULE === "0") return null;
  const cwd = typeof payload?.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
  const capsule = await buildRepoCapsule({ cwd, exec });
  if (!capsule.available || !capsule.text) return null;

  // Count the snapshot for offline_stats, as the Pi extension does, but only
  // where the engine's state directory already exists: the plugin is often
  // installed for the user, and a session start must not create .pi/ in every
  // repository it is opened in.
  if (existsSync(path.join(cwd, ".pi", "offline-engine"))) {
    try {
      await appendEvent(cwd, {
        type: "repo_capsule_injected",
        fingerprint: capsule.fingerprint,
        dirtyFiles: capsule.facts?.dirty?.length ?? 0,
        projectFiles: capsule.facts?.projectFiles?.length ?? 0
      });
    } catch {
      // Telemetry only.
    }
  }
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: capsule.text } };
}

if (process.argv[1]?.endsWith("repo-capsule.mjs")) {
  try {
    const output = await capsuleHookPayload(JSON.parse(readFileSync(0, "utf8") || "{}"));
    if (output) process.stdout.write(JSON.stringify(output));
  } catch {
    // Never break session start.
  }
}
