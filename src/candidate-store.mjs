import fs from "node:fs/promises";
import path from "node:path";
import { sha256 } from "./workspace-snapshot.mjs";

export async function saveCandidateRecord(cwd, record) {
  const dir = path.join(cwd, ".pi", "offline-engine", "candidates");
  await fs.mkdir(dir, { recursive: true });
  const key = sha256(String(record.spec.spec_id)).slice(0, 24);
  const file = path.join(dir, `${key}-attempt-${record.attempt}.json`);
  await fs.writeFile(file, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), ...record }, null, 2), "utf8");
  return file;
}
