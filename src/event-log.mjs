import fs from "node:fs/promises";
import path from "node:path";
import { ensureSelfIgnoringStateDir } from "./state-dir.mjs";

export async function appendEvent(cwd, event) {
  const dir = await ensureSelfIgnoringStateDir(cwd);
  const file = path.join(dir, "events.jsonl");
  const row = { ts: new Date().toISOString(), ...event };
  await fs.appendFile(file, JSON.stringify(row) + "\n", "utf8");
  return file;
}
