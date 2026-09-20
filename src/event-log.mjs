import fs from "node:fs/promises";
import path from "node:path";

export async function appendEvent(cwd, event) {
  const dir = path.join(cwd, ".pi", "offline-engine");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "events.jsonl");
  const row = { ts: new Date().toISOString(), ...event };
  await fs.appendFile(file, JSON.stringify(row) + "\n", "utf8");
  return file;
}
