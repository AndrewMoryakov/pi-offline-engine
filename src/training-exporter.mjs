import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const SECRET_RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
  [/\bAuthorization\s*:\s*Bearer\s+[^\s"',;}{]+/gi, "Authorization: Bearer [REDACTED_TOKEN]"],
  [/\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis):\/\/([^:\s/@]+):([^@\s/]+)@/gi, (match, user) => match.replace(/\/\/[^:]+:[^@]+@/, `//${user}:[REDACTED_PASSWORD]@`)],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED_AWS_ACCESS_KEY_ID]"],
  [/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_OPENAI_KEY]"],
  [/\b(?:ghp_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/([A-Za-z0-9_.-]*(?:API[_-]?KEY|ACCESS[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)[A-Za-z0-9_.-]*)\s*=\s*([^\s"'\`;}{]+)/gi, "$1=[REDACTED_SECRET]"],
  [/(["']?[A-Za-z0-9_.-]*(?:api[_-]?key|access[_-]?key|token|secret|password|private[_-]?key)[A-Za-z0-9_.-]*["']?)\s*:\s*["']([^"'\r\n]{6,})["']/gi, '$1:"[REDACTED_SECRET]"']
];

const SENSITIVE_PATH_PATTERNS = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)(?:id_rsa|id_ed25519|credentials?|secrets?)(?:\.|$|\/)/i,
  /\.(?:pem|p12|pfx|key)$/i
];

export async function exportTrainingData({
  cwd,
  inputFile = path.join(cwd, ".pi", "offline-engine", "training", "raw.jsonl"),
  outputDir = path.join(cwd, ".pi", "offline-engine", "training", "export"),
  includeFailedPreference = true
}) {
  const rows = await readJsonl(inputFile);
  await fs.mkdir(outputDir, { recursive: true });

  const sft = [];
  const preference = [];
  const evalRows = [];
  const pairedGroups = new Map();
  const seen = new Set();
  let droppedSensitive = 0;
  let droppedDuplicate = 0;
  let droppedIncomplete = 0;

  for (const raw of rows) {
    if (raw.kind !== "implementation_attempt") continue;
    if (!raw.input?.implementation_spec || !raw.output?.candidate) {
      droppedIncomplete += 1;
      continue;
    }
    if (hasSensitivePath(raw.input.implementation_spec, raw.output.candidate)) {
      droppedSensitive += 1;
      continue;
    }

    const promptObject = {
      implementation_spec: raw.input.implementation_spec,
      context: raw.input.context ?? {},
      repair_packet: raw.input.repair_packet ?? null
    };
    const prompt = redactDeep(promptObject);
    const completion = redactDeep(raw.output.candidate);
    const promptHash = stableHash(prompt);
    const fingerprint = stableHash({ prompt, completion });

    if (seen.has(fingerprint)) {
      droppedDuplicate += 1;
      continue;
    }
    seen.add(fingerprint);

    const commonMeta = {
      source_run_id: raw.run_id,
      spec_id: raw.spec_id,
      attempt: raw.attempt,
      model: raw.model ?? null,
      outcome: raw.supervision?.outcome ?? null
    };

    evalRows.push({
      prompt,
      completion,
      label: raw.supervision?.verification_passed === true,
      verification: redactDeep(raw.supervision ?? {}),
      meta: commonMeta
    });

    if (raw.supervision?.verification_passed === true && completion?.status === "candidate") {
      sft.push({
        prompt: JSON.stringify(prompt),
        completion: JSON.stringify(completion),
        meta: commonMeta
      });
    }

    if (includeFailedPreference && completion?.status === "candidate") {
      const passed = raw.supervision?.verification_passed === true;
      preference.push({
        prompt: JSON.stringify(prompt),
        completion: JSON.stringify(completion),
        label: passed,
        meta: commonMeta
      });

      let group = pairedGroups.get(promptHash);
      if (!group) {
        group = { prompt, chosen: [], rejected: [] };
        pairedGroups.set(promptHash, group);
      }
      (passed ? group.chosen : group.rejected).push({ completion, meta: commonMeta });
    }
  }

  const pairedPreference = [];
  for (const group of pairedGroups.values()) {
    if (group.chosen.length === 0 || group.rejected.length === 0) continue;
    for (const chosen of group.chosen) {
      for (const rejected of group.rejected.slice(0, 3)) {
        pairedPreference.push({
          prompt: JSON.stringify(group.prompt),
          chosen: JSON.stringify(chosen.completion),
          rejected: JSON.stringify(rejected.completion),
          meta: {
            chosen: chosen.meta,
            rejected: rejected.meta
          }
        });
      }
    }
  }

  const files = {
    sft: path.join(outputDir, "sft.jsonl"),
    preference: path.join(outputDir, "unpaired-preference.jsonl"),
    pairedPreference: path.join(outputDir, "paired-preference.jsonl"),
    eval: path.join(outputDir, "eval.jsonl")
  };

  await writeJsonl(files.sft, sft);
  await writeJsonl(files.preference, preference);
  await writeJsonl(files.pairedPreference, pairedPreference);
  await writeJsonl(files.eval, evalRows);

  const manifest = {
    schema_version: 1,
    exported_at: new Date().toISOString(),
    input_file: path.relative(cwd, inputFile).replaceAll("\\", "/"),
    rows_read: rows.length,
    sft_examples: sft.length,
    preference_examples: preference.length,
    paired_preference_examples: pairedPreference.length,
    eval_examples: evalRows.length,
    dropped_sensitive: droppedSensitive,
    dropped_duplicate: droppedDuplicate,
    dropped_incomplete: droppedIncomplete,
    files: Object.fromEntries(Object.entries(files).map(([key, value]) => [
      key,
      path.relative(cwd, value).replaceAll("\\", "/")
    ]))
  };
  const manifestPath = path.join(outputDir, "manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  return { ...manifest, manifest: path.relative(cwd, manifestPath).replaceAll("\\", "/") };
}

export function redactDeep(value) {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item)]));
  }
  return value;
}

export function redactString(value) {
  let result = String(value);
  for (const [pattern, replacement] of SECRET_RULES) result = result.replace(pattern, replacement);
  return result;
}

function hasSensitivePath(spec, candidate = null) {
  const paths = [
    spec?.target?.file,
    ...(Array.isArray(spec?.scope?.allowed_files) ? spec.scope.allowed_files : []),
    ...(Array.isArray(candidate?.changes) ? candidate.changes.map((change) => change?.path) : [])
  ].filter(Boolean);
  return paths.some((value) => SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(String(value).replaceAll("\\", "/"))));
}

async function readJsonl(file) {
  try {
    const text = await fs.readFile(file, "utf8");
    const rows = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch {}
    }
    return rows;
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function writeJsonl(file, rows) {
  const body = rows.map((row) => JSON.stringify(row)).join("\n");
  await fs.writeFile(file, body ? body + "\n" : "", "utf8");
}

function stableHash(value) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stableStringify(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}
