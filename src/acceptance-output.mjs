import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const ACCEPTANCE_MARKER = ".pi-offline-acceptance-fixture";

export async function prepareAcceptanceOutputDirectory({ output, cwd, repoRoot }) {
  const resolved = path.resolve(output);
  const current = path.resolve(cwd);
  const repository = path.resolve(repoRoot);
  const fsRoot = path.parse(resolved).root;
  const home = path.resolve(os.homedir());

  if (
    resolved === current ||
    resolved === repository ||
    resolved === fsRoot ||
    resolved === home ||
    isAncestor(resolved, current) ||
    isAncestor(resolved, repository) ||
    isAncestor(resolved, home)
  ) {
    throw new Error("Refusing to use a destructive acceptance output path: " + resolved);
  }

  try {
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      throw new Error("Acceptance output exists and is not a directory: " + resolved);
    }

    const marker = path.join(resolved, ACCEPTANCE_MARKER);
    try {
      await fs.access(marker);
    } catch {
      throw new Error("Refusing to delete existing output without acceptance marker: " + resolved);
    }

    await fs.rm(resolved, { recursive: true, force: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  return resolved;
}

export function isAncestor(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative);
}
