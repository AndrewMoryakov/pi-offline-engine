import fs from "node:fs/promises";
import path from "node:path";

const LEDGER = ".pi/offline-engine/events.jsonl";

// A failing write rejects with a stable message naming the ledger and the fs
// error code. The raw fs message is not passed on: it differs by platform
// (Linux names open() and the absolute path, Windows names write()). The
// original error stays reachable as `cause`, and its code as `code`.
export async function appendEvent(cwd, event) {
  const dir = path.join(cwd, ".pi", "offline-engine");
  const file = path.join(dir, "events.jsonl");
  const row = { ts: new Date().toISOString(), ...event };
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(file, JSON.stringify(row) + "\n", "utf8");
  } catch (error) {
    const code = error?.code ?? (error instanceof Error ? error.message : String(error));
    throw Object.assign(new Error(`Event ledger ${LEDGER} is not writable (${code})`, { cause: error }), { code: error?.code });
  }
  return file;
}
