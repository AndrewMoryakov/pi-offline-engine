import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const MAX_CURRENT_FILE_BYTES = 16 * 1024;

export async function snapshotAllowedFiles(cwd, spec) {
  return (await captureAllowedFiles(cwd, spec)).snapshot;
}

// The preimage snapshot plus, when asked, the current text of each allowed
// file read from the same bytes that were hashed, so what the implementer is
// shown is exactly the state the stale-preimage check later compares against.
// Files over maxBytes are named but not included, to keep small implementer
// context windows usable.
export async function captureAllowedFiles(cwd, spec, { withContent = false, maxBytes = MAX_CURRENT_FILE_BYTES } = {}) {
  const root = await fs.realpath(cwd);
  const files = {};
  const currentFiles = withContent ? {} : null;
  for (const relative of spec.scope.allowed_files) {
    const absolute = resolveInside(root, relative);
    await assertNoSymlinkSegments(root, absolute);
    try {
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error(`symbolic links are not allowed: ${relative}`);
      if (!stat.isFile()) throw new Error(`allowed path is not a regular file: ${relative}`);
      const content = await fs.readFile(absolute);
      files[relative] = { exists: true, sha256: sha256(content), size: content.length };
      if (currentFiles) {
        currentFiles[relative] = content.length <= maxBytes
          ? { exists: true, content: content.toString("utf8") }
          : { exists: true, omitted: `${content.length} bytes exceeds the ${maxBytes}-byte limit; use context excerpts` };
      }
    } catch (error) {
      if (error?.code === "ENOENT") {
        files[relative] = { exists: false, sha256: null, size: 0 };
        if (currentFiles) currentFiles[relative] = { exists: false };
      } else throw error;
    }
  }
  return { snapshot: { version: 1, root, files }, currentFiles };
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
