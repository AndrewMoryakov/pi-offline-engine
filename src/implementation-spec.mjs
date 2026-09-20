import path from "node:path";

const ALLOWED_OPERATIONS = new Set(["replace_text", "create_file"]);
const ALLOWED_SPEC_OPERATIONS = new Set(["modify_symbol"]);
const ALLOWED_STATUSES = new Set(["candidate", "insufficient_spec", "cannot_safely_implement"]);

export function validateImplementationSpec(spec) {
  const errors = [];
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return { ok: false, errors: ["spec must be an object"] };
  if (spec.version !== 1) errors.push("version must be 1");
  if (!isNonEmpty(spec.spec_id)) errors.push("spec_id is required");
  if (!ALLOWED_SPEC_OPERATIONS.has(spec.operation)) errors.push("operation must be modify_symbol in v1");
  if (!spec.target || !isSafeRelativePath(spec.target.file)) errors.push("target.file must be a safe relative path");
  if (!isNonEmpty(spec.target?.symbol)) errors.push("target.symbol is required");
  if (!isNonEmpty(spec.goal?.summary)) errors.push("goal.summary is required");

  const allowedFiles = spec.scope?.allowed_files;
  if (!Array.isArray(allowedFiles) || allowedFiles.length === 0) errors.push("scope.allowed_files must be a non-empty array");
  else {
    const seen = new Set();
    for (const file of allowedFiles) {
      if (!isSafeRelativePath(file)) errors.push(`unsafe allowed file: ${String(file)}`);
      if (seen.has(file)) errors.push(`duplicate allowed file: ${String(file)}`);
      seen.add(file);
    }
    if (isSafeRelativePath(spec.target?.file) && !allowedFiles.includes(spec.target.file)) {
      errors.push("target.file must be included in scope.allowed_files");
    }
    if (allowedFiles.length > 2) errors.push("v1 delegation is limited to at most 2 allowed files");
  }

  if (!Array.isArray(spec.requirements) || spec.requirements.length === 0 || spec.requirements.some((x) => !isNonEmpty(x))) {
    errors.push("requirements must be a non-empty array of strings");
  }

  validateVerification(spec.verification, errors);
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
  const createPaths = new Set();
  for (const change of candidate.changes) {
    if (!ALLOWED_OPERATIONS.has(change.operation)) errors.push(`unsupported operation: ${String(change.operation)}`);
    if (!isSafeRelativePath(change.path)) errors.push(`unsafe path: ${String(change.path)}`);
    else if (!allowedFiles.has(change.path)) errors.push(`path outside allowed scope: ${change.path}`);

    if (change.operation === "replace_text") {
      if (!isNonEmpty(change.expected)) errors.push(`replace_text expected text is required for ${String(change.path)}`);
      if (typeof change.content !== "string") errors.push(`replace_text content must be a string for ${String(change.path)}`);
      if (change.expected === change.content) errors.push(`replace_text must change content for ${String(change.path)}`);
    }

    if (change.operation === "create_file") {
      if (spec.scope?.allow_new_files !== true) errors.push(`create_file not allowed by spec for ${String(change.path)}`);
      if (typeof change.content !== "string" || change.content.length === 0) errors.push(`create_file content is required for ${String(change.path)}`);
      if (createPaths.has(change.path)) errors.push(`duplicate create_file for ${String(change.path)}`);
      createPaths.add(change.path);
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

function validateVerification(verification, errors) {
  if (!verification || typeof verification !== "object" || Array.isArray(verification)) {
    errors.push("verification is required");
    return;
  }

  let hasCheck = false;
  if (verification.build !== undefined) {
    hasCheck = true;
    if (!verification.build || !isSafeRelativePath(verification.build.project)) errors.push("verification.build.project must be a safe relative path");
  }

  if (verification.tests !== undefined) {
    hasCheck = true;
    if (!verification.tests || !isSafeRelativePath(verification.tests.project)) errors.push("verification.tests.project must be a safe relative path");
    const names = verification.tests?.names;
    if (names !== undefined && (!Array.isArray(names) || names.some((x) => !isNonEmpty(x)))) {
      errors.push("verification.tests.names must be an array of non-empty strings");
    }
  }

  if (!hasCheck) errors.push("verification must define build and/or tests");
}

function isNonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}
