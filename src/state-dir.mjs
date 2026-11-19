import fs from "node:fs/promises";
import path from "node:path";

// Engine state (.pi/offline-engine/) holds verification logs, candidate
// records and tool output, which can contain private source. Outside this
// repository nothing guarantees the directory is ignored, so it ignores
// itself.
//
// Every writer under .pi/offline-engine/ (event ledger, candidates, artifacts,
// test results, tool results, training trace and export) creates its directory
// through this module, so the Pi extension, the MCP server and the Claude Code
// hook cannot leave state that Git can see. A directory left by an earlier
// version without the file gets it on the next write.
export async function ensureSelfIgnoringStateDir(cwd) {
  const dir = path.join(cwd, ".pi", "offline-engine");
  await fs.mkdir(dir, { recursive: true });
  const ignore = path.join(dir, ".gitignore");
  try {
    await fs.writeFile(ignore, "*\n", { flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  return dir;
}

// A directory below the state directory, created together with its ignore
// file. Writers use this instead of their own mkdir.
export async function ensureStateSubdir(cwd, ...segments) {
  const dir = path.join(await ensureSelfIgnoringStateDir(cwd), ...segments);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}
