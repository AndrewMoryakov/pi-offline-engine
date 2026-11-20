import fs from "node:fs/promises";
import path from "node:path";

// The engine keeps full build and test logs, TRX files and candidate records
// under .pi/offline-engine/ so a model can open them when a summary is not
// enough. Nothing removed them, so the folder grew with every compacted build
// and every verification. It also fed searches: a plain `grep -rn Name .` in
// the repository matched old logs and returned the text compaction had kept
// out of context (22 to 43% of the output for three searches in one
// repository after a single verification run). Git, Pi's grep tool and
// ripgrep skip the folder through its .gitignore; `grep -r` does not.
//
// Each of the four folders below keeps its newest entries: at most `keep`
// entries and `maxBytes` in total, the newest entry always, and never an entry
// the caller names in `protect` (the one it has just written). The event
// ledger and training data are not touched: statistics read the whole ledger,
// and training capture is the user's own data.
export const PRUNED_STATE_DIRS = ["tool-results", "artifacts", "test-results", "candidates"];
export const DEFAULT_KEEP_ENTRIES = 20;
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const MAX_KEEP_ENTRIES = 10_000;

export function stateRetentionLimits(env = process.env) {
  const raw = env?.PI_OFFLINE_STATE_KEEP;
  const value = raw === undefined || raw === "" ? NaN : Number(raw);
  const keep = Number.isInteger(value) && value >= 1 && value <= MAX_KEEP_ENTRIES ? value : DEFAULT_KEEP_ENTRIES;
  return { keep, maxBytes: keep === DEFAULT_KEEP_ENTRIES ? DEFAULT_MAX_BYTES : Math.max(DEFAULT_MAX_BYTES, keep * 512 * 1024) };
}

// Removes the oldest entries of one state folder beyond the limits. Returns
// what it did; never throws, because a failed cleanup must not fail the build,
// test run or delegation that triggered it.
export async function pruneStateDir(dir, { keep, maxBytes, protect = [] } = stateRetentionLimits()) {
  const result = { kept: 0, keptBytes: 0, removed: [] };
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return result;
  }

  const measured = [];
  for (const entry of entries) {
    if (entry.name === ".gitignore") continue;
    const full = path.join(dir, entry.name);
    try {
      const stat = await fs.lstat(full);
      const size = stat.isDirectory() ? await directorySize(full) : stat.size;
      measured.push({ name: entry.name, full, mtimeMs: stat.mtimeMs, size, directory: stat.isDirectory() });
    } catch {
      // Removed by another process meanwhile.
    }
  }

  measured.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  for (const item of measured) {
    const protectedEntry = protect.includes(item.name);
    const fits = result.kept < keep && (result.kept === 0 || result.keptBytes + item.size <= maxBytes);
    if (protectedEntry || fits) {
      result.kept += 1;
      result.keptBytes += item.size;
      continue;
    }
    try {
      await fs.rm(item.full, { recursive: true, force: true });
      result.removed.push(item.name);
    } catch {
      // Still in use or already gone; the next write tries again.
    }
  }
  return result;
}

// Prunes `<cwd>/.pi/offline-engine/<name>` after a writer added `protect`.
export async function pruneStateSubdir(cwd, name, protect = [], env = process.env) {
  if (!PRUNED_STATE_DIRS.includes(name)) throw new Error(`not a pruned state folder: ${name}`);
  return pruneStateDir(path.join(cwd, ".pi", "offline-engine", name), { ...stateRetentionLimits(env), protect });
}

async function directorySize(dir) {
  let total = 0;
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      const stat = await fs.lstat(full);
      total += stat.isDirectory() ? await directorySize(full) : stat.size;
    } catch {
      // Gone meanwhile.
    }
  }
  return total;
}
