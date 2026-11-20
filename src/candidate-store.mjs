import fs from "node:fs/promises";
import path from "node:path";
import { ensureStateSubdir } from "./state-dir.mjs";
import { pruneStateSubdir } from "./state-retention.mjs";
import { sha256 } from "./workspace-snapshot.mjs";

export async function saveCandidateRecord(cwd, record) {
  const dir = await ensureStateSubdir(cwd, "candidates");
  const key = sha256(String(record.spec.spec_id)).slice(0, 24);
  const file = path.join(dir, `${key}-attempt-${record.attempt}.json`);
  await fs.writeFile(file, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), ...record }, null, 2), "utf8");
  await pruneStateSubdir(cwd, "candidates", [path.basename(file)]);
  return file;
}
