import fs from "node:fs/promises";
import path from "node:path";
import { ensureSelfIgnoringStateDir } from "./state-dir.mjs";

const LEDGER = ".pi/offline-engine/events.jsonl";

// A failing write rejects with a stable message naming the ledger and the fs
// error code. The raw fs message is not passed on: it differs by platform
// (Linux names open() and the absolute path, Windows names write()). The
// original error stays reachable as `cause`, and its code as `code`.
// The state directory is created together with its own .gitignore, so the
// ledger never shows up in a foreign repository's `git status`.
export async function appendEvent(cwd, event) {
  const row = { ts: new Date().toISOString(), ...event };
  try {
    const dir = await ensureSelfIgnoringStateDir(cwd);
    const file = path.join(dir, "events.jsonl");
    await fs.appendFile(file, JSON.stringify(row) + "\n", "utf8");
    return file;
  } catch (error) {
    const code = error?.code ?? (error instanceof Error ? error.message : String(error));
    throw Object.assign(new Error(`Event ledger ${LEDGER} is not writable (${code})`, { cause: error }), { code: error?.code });
  }
}
