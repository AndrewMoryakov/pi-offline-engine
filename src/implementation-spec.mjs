import path from "node:path";

const ALLOWED_OPERATIONS = new Set(["replace_symbol", "insert_symbol", "replace_region", "create_file"]);
const ALLOWED_STATUSES = new Set(["candidate", "insufficient_spec", "cannot_safely_implement"]);

export function validateImplementationSpec(spec) {
  const errors = [];
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return { ok: false, errors: ["spec must be an object"] };
  if (spec.version !== 1) errors.push("version must be 1");
  if (!isNonEmpty(spec.spec_id)) errors.push("spec_id is required");
  if (!isNonEmpty(spec.operation)) errors.push("operation is required");
  if (!spec.target || !isSafeRelativePath(spec.target.file)) errors.push("target.file must be a safe relative path");
  if (!isNonEmpty(spec.target?.symbol)) errors.push("target.symbol is required");
  if (!isNonEmpty(spec.goal?.summary)) errors.push("goal.summary is required");

  const allowedFiles = spec.scope?.allowed_files;
  if (!Array.isArray(allowedFiles) || allowedFiles.length === 0) errors.push("scope.allowed_files must be a non-empty array");
  else {
    for (const file of allowedFiles) if (!isSafeRelativePath(file)) errors.push(`unsafe allowed file: ${String(file)}`);
    if (isSafeRelativePath(spec.target?.file) && !allowedFiles.includes(spec.target.file)) {
      errors.push("target.file must be included in scope.allowed_files");
    }
  }

  if (!Array.isArray(spec.requirements) || spec.requirements.length === 0) errors.push("requirements must be non-empty");
  if (!spec.verification || typeof spec.verification !== "object") errors.push("verification is required");

  return { ok: errors.length === 0, errors };
}

export function validateCandidate(candidate, spec) {
  const errors = [];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return { ok: false, errors: ["candidate must be an object"] };
  if (!ALLOWED_STATUSES.has(candidate.status)) errors.push("candidate.status is invalid");
  if (candidate.status !== "candidate") return { ok: errors.length === 0, errors };

  if (!Array.isArray(candidate.changes) || candidate.changes.length === 0) {
    errors.push("candidate.changes must be non-empty");
    return { ok: false, errors };
  }

  const allowedFiles = new Set(spec.scope.allowed_files);
  for (const change of candidate.changes) {
    if (!ALLOWED_OPERATIONS.has(change.operation)) errors.push(`unsupported operation: ${String(change.operation)}`);
    if (!isSafeRelativePath(change.path)) errors.push(`unsafe path: ${String(change.path)}`);
    else if (!allowedFiles.has(change.path) && !(change.operation === "create_file" && spec.scope.allow_new_files === true)) {
      errors.push(`path outside allowed scope: ${change.path}`);
    }
    if (!isNonEmpty(change.content)) errors.push(`change content is required for ${String(change.path)}`);
    if (change.operation !== "create_file" && !isNonEmpty(change.symbol) && change.operation !== "replace_region") {
      errors.push(`symbol is required for ${change.operation}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function isSafeRelativePath(value) {
  if (!isNonEmpty(value)) return false;
  if (path.isAbsolute(value)) return false;
  const normalized = path.posix.normalize(String(value).replaceAll("\\", "/"));
  return normalized !== ".." && !normalized.startsWith("../") && normalized !== "." && !normalized.includes("/../");
}

function isNonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}
