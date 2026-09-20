import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export async function snapshotAllowedFiles(cwd, spec) {
  const root = await fs.realpath(cwd);
  const files = {};
  for (const relative of spec.scope.allowed_files) {
    const absolute = resolveInside(root, relative);
    await assertNoSymlinkSegments(root, absolute);
    try {
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error(`symbolic links are not allowed: ${relative}`);
      if (!stat.isFile()) throw new Error(`allowed path is not a regular file: ${relative}`);
      const content = await fs.readFile(absolute);
      files[relative] = { exists: true, sha256: sha256(content), size: content.length };
    } catch (error) {
      if (error?.code === "ENOENT") files[relative] = { exists: false, sha256: null, size: 0 };
      else throw error;
    }
  }
  return { version: 1, root, files };
}

export async function verifySnapshot(cwd, snapshot) {
  const currentRoot = await fs.realpath(cwd);
  const errors = [];
  if (currentRoot !== snapshot.root) errors.push("workspace root changed since delegation");

  for (const [relative, expected] of Object.entries(snapshot.files)) {
    const absolute = resolveInside(currentRoot, relative);
    try {
      await assertNoSymlinkSegments(currentRoot, absolute);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        errors.push(`file type changed: ${relative}`);
        continue;
      }
      const content = await fs.readFile(absolute);
      const actualHash = sha256(content);
      if (!expected.exists) errors.push(`file appeared after delegation: ${relative}`);
      else if (actualHash !== expected.sha256) errors.push(`file changed after delegation: ${relative}`);
    } catch (error) {
      if (error?.code === "ENOENT") {
        if (expected.exists) errors.push(`file disappeared after delegation: ${relative}`);
      } else {
        throw error;
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export function resolveInside(root, relative) {
  const absolute = path.resolve(root, relative);
  const rel = path.relative(root, absolute);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`path escapes workspace: ${relative}`);
  return absolute;
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function assertNoSymlinkSegments(root, absolute) {
  const rel = path.relative(root, absolute);
  const parts = rel.split(path.sep).filter(Boolean);
  let cursor = root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error(`symbolic link path segment is not allowed: ${cursor}`);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
  }
}
