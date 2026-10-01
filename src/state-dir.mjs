import fs from "node:fs/promises";
import path from "node:path";

// Engine state (.pi/offline-engine/) holds verification logs, candidate
// records and tool output, which can contain private source. Outside this
// repository nothing guarantees the directory is ignored, so it ignores
// itself.
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
