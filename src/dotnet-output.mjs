// One reader of `dotnet build` / `dotnet test` console output, shared by the
// tool-result compactor (what the main model sees) and the repair packet (what
// the implementer sees after a failed check).
//
// It recognises canonical shapes, not words. A line counts as a compiler or
// MSBuild diagnostic only in the form `origin[(line,col)]: error|warning CODE:
// text`; a failed test is the whole block from its header to the next one, so
// the "Expected"/"Actual" lines that carry no keyword stay with it. Anything
// the reader does not recognise is left to the keyword fallback, so a failure
// in an unknown shape is never shown with less than before.
//
// Shapes come from real output captured on Linux with .NET SDK 10.0.404:
// MSBuild minimal and detailed verbosity, VSTest with xUnit, NUnit and MSTest,
// and Microsoft.Testing.Platform (MTP) with MSTest. Localised output and other
// test frameworks fall through to the fallback.

const DIAGNOSTIC = /^\s*(?<origin>[^\s:][^:]*?|[A-Za-z]:\\[^:]*?)(?:\((?<pos>\d+(?:,\d+){0,3})\))?\s*:\s+(?:(?<sub>[A-Za-z][\w ]*?)\s+)?(?<sev>error|warning)(?:\s+(?<code>[A-Za-z]{1,12}\d{1,6}))?\s*:\s*(?<text>.*)$/;
const PROJECT_SUFFIX = /\s+\[[^\]]+\.(?:[a-z]{2}proj|proj|slnx?|props|targets)(?:::[^\]]*)?\]\s*$/i;

const BUILD_SUCCEEDED = /^\s*Build succeeded\b/i;
const BUILD_FAILED = /^\s*Build FAILED\b|^\s*Build failed with\b/i;
const WARNING_TOTAL = /^\s*(\d+)\s+Warning\(s\)\s*$/i;
const ERROR_TOTAL = /^\s*(\d+)\s+Error\(s\)\s*$/i;

const VSTEST_HEADER = /^\s{1,4}(?<status>Failed|Passed|Skipped)\s+(?<name>\S.*?)\s+\[[^\]]*\]\s*$/;
const VSTEST_SUMMARY = /^\s*(?<verdict>Failed|Passed)!\s+-\s+Failed:\s+(?<failed>\d+),\s+Passed:\s+(?<passed>\d+),\s+Skipped:\s+(?<skipped>\d+),\s+Total:\s+(?<total>\d+)/;
const MTP_HEADER = /^(?<status>failed|passed|skipped)\s+(?<name>\S.*?)\s+\([^()]*\d\s*(?:ms|s)\)\s*$/;
const MTP_SUMMARY = /^\s*Test run summary:\s*(?<verdict>Passed|Failed|Aborted|Zero tests ran)\b/i;
const MTP_COUNTER = /^\s{1,4}(?<name>total|failed|succeeded|skipped):\s*(?<value>\d+)\s*$/i;
const RUN_AFTER_BLOCKS = /^\s*(?:Test Run (?:Failed|Successful|Aborted)\b|Total tests:|Results File:|Test run summary:|In process file artifacts produced:|Exit code:\s*\d|\[xUnit\.net\b)|^\S.*\bfailed with \d+ error\(s\)/i;
const CRASH = /Test host process crashed|The active test run was aborted|^\s*Test Run Aborted\b|^\s*Unhandled exception\b|test host process exited/i;
const SECTION = /^\s*(?<section>Error Message|Stack Trace|Standard Output Messages|Standard Error Messages|Debug Trace|Additional Information|Messages):\s*$/;
const FRAME = /^\s*(?:\d+\)\s+)?at\s+(?<method>.+?)(?:\s+in\s+(?<file>.+?):(?:line\s+)?(?<line>\d+))?\s*$/;
const FRAMEWORK_METHOD = /^(?:System|Microsoft|Xunit|NUnit|MSTest|NSubstitute|Moq|FluentAssertions|Shouldly)\./;

const MAX_MESSAGE_LINES = 8;
const MAX_LINE_CHARS = 400;

export function parseDotnetOutput(text, { cwd = null } = {}) {
  const lines = String(text ?? "").split(/\r?\n/).map((line) => stripAnsi(line).trimEnd());
  const relative = makeRelativizer(cwd);

  const errors = new Map();
  const warnings = new Map();
  const build = { succeeded: false, failed: false, errorTotal: null, warningTotal: null };
  const tests = { runs: [], failures: [], verdict: null, total: null, failed: null, passed: null, skipped: null };
  const crash = [];
  let mtpSummary = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;

    if (BUILD_SUCCEEDED.test(line)) { build.succeeded = true; continue; }
    if (BUILD_FAILED.test(line)) { build.failed = true; continue; }
    let match = line.match(WARNING_TOTAL);
    if (match) { build.warningTotal = Number(match[1]); continue; }
    match = line.match(ERROR_TOTAL);
    if (match) { build.errorTotal = Number(match[1]); continue; }

    match = line.match(VSTEST_SUMMARY);
    if (match) {
      tests.runs.push({
        verdict: match.groups.verdict.toLowerCase(),
        failed: Number(match.groups.failed),
        passed: Number(match.groups.passed),
        skipped: Number(match.groups.skipped),
        total: Number(match.groups.total)
      });
      continue;
    }

    match = line.match(MTP_SUMMARY);
    if (match) {
      mtpSummary = { verdict: match.groups.verdict.toLowerCase(), total: null, failed: null, passed: null, skipped: null };
      for (let next = index + 1; next < lines.length; next += 1) {
        const counter = lines[next].match(MTP_COUNTER);
        if (!counter) break;
        const key = counter.groups.name.toLowerCase();
        mtpSummary[key === "succeeded" ? "passed" : key] = Number(counter.groups.value);
        index = next;
      }
      continue;
    }

    if (CRASH.test(line)) {
      index = readCrash(lines, index, crash, relative);
      continue;
    }

    const header = line.match(VSTEST_HEADER) ?? line.match(MTP_HEADER);
    if (header && header.groups.status.toLowerCase() === "failed") {
      const block = readFailureBlock(lines, index + 1, relative);
      tests.failures.push({ name: header.groups.name, message: block.message, frame: block.frame });
      index = block.end - 1;
      continue;
    }

    const diagnostic = parseDiagnosticLine(line, relative);
    if (diagnostic) {
      const target = diagnostic.severity === "error" ? errors : warnings;
      if (!target.has(diagnostic.key)) target.set(diagnostic.key, diagnostic);
    }
  }

  if (mtpSummary) tests.runs.push(mtpSummary);
  if (tests.runs.length > 0) {
    tests.verdict = tests.runs.some((run) => run.verdict !== "passed") ? "failed" : "passed";
    if (tests.runs.some((run) => run.verdict === "aborted")) tests.verdict = "aborted";
    for (const key of ["total", "failed", "passed", "skipped"]) {
      const values = tests.runs.map((run) => run[key]).filter((value) => typeof value === "number");
      tests[key] = values.length ? values.reduce((sum, value) => sum + value, 0) : null;
    }
  }

  return {
    build,
    errors: [...errors.values()],
    warnings: [...warnings.values()],
    tests,
    crash
  };
}

export function parseDiagnosticLine(line, relative = (value) => value) {
  const withoutProject = String(line).replace(PROJECT_SUFFIX, "");
  const match = withoutProject.match(DIAGNOSTIC);
  if (!match) return null;
  const origin = match.groups.origin.trim();
  // `Errors: MSB4276: ...` from a detailed log and similar `Name: value` lines
  // have no severity word after the origin; a real origin is a path or a tool
  // name, never a sentence.
  if (/\s{2,}/.test(origin) || origin.length > 400) return null;
  const position = match.groups.pos ? `(${match.groups.pos})` : "";
  const severity = match.groups.sev.toLowerCase();
  const code = match.groups.code ?? "";
  const text = match.groups.text.trim();
  const shownOrigin = relative(origin);
  const display = `${shownOrigin}${position}: ${severity}${code ? ` ${code}` : ""}: ${text}`;
  return { severity, code, origin: shownOrigin, position, text, display, key: `${shownOrigin}${position}|${code}|${text}` };
}

function readFailureBlock(lines, start, relative) {
  const message = [];
  const frames = [];
  let section = "message";
  let index = start;

  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (VSTEST_HEADER.test(line) || MTP_HEADER.test(line) || VSTEST_SUMMARY.test(line) || RUN_AFTER_BLOCKS.test(line) || CRASH.test(line)) break;
    if (DIAGNOSTIC.test(line.replace(PROJECT_SUFFIX, "")) && /\((\d+)(?:,\d+)*\)\s*:\s+(?:error|warning)\b/.test(line)) break;
    if (!line.trim()) continue;

    const sectionMatch = line.match(SECTION);
    if (sectionMatch) {
      const name = sectionMatch.groups.section;
      section = name === "Error Message" ? "message" : name === "Stack Trace" ? "stack" : "ignored";
      continue;
    }

    const frame = line.match(FRAME);
    if (frame) {
      frames.push(frame.groups);
      continue;
    }

    // MTP prints the assembly under the header: "  from /path/Tests.dll (net8.0|x64)".
    if (/^\s+from\s+\S.*\.(?:dll|exe)\b/i.test(line)) continue;
    if (section === "message") message.push(line.trim());
  }

  return { message: message.slice(0, MAX_MESSAGE_LINES).map((line) => clip(line)), frame: chooseFrame(frames, relative), end: index };
}

function readCrash(lines, index, crash, relative) {
  crash.push(clip(lines[index].trim()));
  const frames = [];
  let next = index + 1;
  for (; next < lines.length; next += 1) {
    const line = lines[next];
    if (!line.trim()) break;
    if (VSTEST_SUMMARY.test(line) || MTP_SUMMARY.test(line) || CRASH.test(line)) break;
    const frame = line.match(FRAME);
    if (frame) frames.push(frame.groups);
    else if (frames.length === 0 && crash.length < 6) crash.push(clip(line.trim()));
  }
  const frame = chooseFrame(frames, relative);
  if (frame) crash.push(frame);
  return next - 1;
}

// The first frame that belongs to the project under test: a source path that
// is not a framework's deterministic `/_/` build path, preferring files inside
// the workspace; failing that, the first method outside the BCL and the test
// frameworks (a crash stack often has no file at all).
function chooseFrame(frames, relative) {
  if (frames.length === 0) return null;
  const withFile = frames.filter((frame) => frame.file && !/^\/_\/|[\\/]_[\\/]src[\\/]/.test(frame.file));
  const inside = withFile.find((frame) => relative(frame.file) !== frame.file);
  const chosen = inside ?? withFile[0] ?? frames.find((frame) => !FRAMEWORK_METHOD.test(frame.method));
  if (!chosen) return null;
  const location = chosen.file ? ` in ${relative(chosen.file)}:line ${chosen.line}` : "";
  return clip(`at ${chosen.method}${location}`);
}

// Turns the parse into lines for a model. `budget` counts characters of the
// returned lines; sections are added in priority order (verdict, errors,
// crash, failed tests, warnings) and whatever does not fit is summarised by a
// count, so the verdict and the first error are always present.
export function formatDotnetReport(parsed, { budget = 6000, fullFailures = 5, maxWarningCodes = 8 } = {}) {
  const out = [];
  let used = 0;
  let omitted = 0;
  const push = (line, { force = false } = {}) => {
    if (!force && used + line.length + 1 > budget) { omitted += 1; return false; }
    out.push(line);
    used += line.length + 1;
    return true;
  };

  push(`Result: ${describeVerdict(parsed)}`, { force: true });

  if (parsed.errors.length > 0) {
    push(`Errors (${parsed.errors.length} unique):`, { force: true });
    parsed.errors.forEach((error, index) => push(`  ${clip(error.display)}`, { force: index === 0 }));
  }

  if (parsed.crash.length > 0) {
    push("Test run aborted:", { force: true });
    parsed.crash.forEach((line, index) => push(`  ${line}`, { force: index < 2 }));
  }

  const failures = parsed.tests.failures;
  if (failures.length > 0) {
    const total = parsed.tests.failed ?? failures.length;
    push(`Failed tests (${total}${parsed.tests.total !== null ? ` of ${parsed.tests.total}` : ""}):`, { force: true });
    const shown = failures.slice(0, fullFailures);
    shown.forEach((failure, index) => {
      push(`  ${failure.name}`, { force: index === 0 });
      for (const line of failure.message) push(`    ${line}`, { force: index === 0 });
      if (failure.frame) push(`    ${failure.frame}`, { force: index === 0 });
    });
    const rest = failures.slice(fullFailures);
    const groups = groupByFirstLine(rest);
    for (const group of groups.slice(0, 4)) {
      const names = group.names.join(", ");
      const head = group.firstLine ? `, first message like "${clip(group.firstLine, 120)}"` : "";
      push(`  Also failed (${group.names.length})${head}: ${clip(names, 900)}`);
    }
    const others = groups.slice(4).flatMap((group) => group.names);
    if (others.length > 0) push(`  Also failed (${others.length}): ${clip(others.join(", "), 900)}`);
    if (total > failures.length) push(`  (${total - failures.length} more failed tests are not printed in this output)`);
  }

  if (parsed.warnings.length > 0) {
    const byCode = new Map();
    for (const warning of parsed.warnings) {
      const key = warning.code || "(no code)";
      if (!byCode.has(key)) byCode.set(key, []);
      byCode.get(key).push(warning);
    }
    const codes = [...byCode.entries()].sort((a, b) => b[1].length - a[1].length);
    push(`Warnings (${parsed.warnings.length} unique, ${codes.length} code${codes.length === 1 ? "" : "s"}):`);
    for (const [code, items] of codes.slice(0, maxWarningCodes)) {
      push(`  ${code} x${items.length}, first: ${clip(items[0].display, 260)}`);
    }
    if (codes.length > maxWarningCodes) push(`  (${codes.length - maxWarningCodes} more warning codes)`);
  }

  if (omitted > 0) out.push(`(${omitted} more line${omitted === 1 ? "" : "s"} did not fit; they are in the full output)`);
  return out;
}

export function describeVerdict(parsed) {
  const parts = [];
  const { build, tests } = parsed;
  const errorCount = build.errorTotal ?? parsed.errors.length;
  const warningCount = build.warningTotal ?? parsed.warnings.length;

  if (build.failed || (parsed.errors.length > 0 && !build.succeeded)) {
    parts.push(`Build FAILED, ${plural(errorCount, "error")}, ${plural(warningCount, "warning")}`);
  } else if (build.succeeded) {
    parts.push(`Build succeeded, ${plural(warningCount, "warning")}`);
  }

  if (tests.verdict === "aborted" || (parsed.crash.length > 0 && tests.verdict !== "failed")) {
    parts.push("Test run ABORTED");
  }
  if (tests.verdict === "failed" || tests.verdict === "passed") {
    const counts = [
      tests.failed !== null ? `${tests.failed} failed` : null,
      tests.passed !== null ? `${tests.passed} passed` : null,
      tests.skipped !== null ? `${tests.skipped} skipped` : null
    ].filter(Boolean).join(", ");
    parts.push(`Tests ${tests.verdict === "failed" ? "FAILED" : "passed"}${counts ? `, ${counts}` : ""}${tests.total !== null ? ` of ${tests.total}` : ""}`);
  } else if (tests.failures.length > 0) {
    parts.push(`Tests FAILED, ${plural(tests.failures.length, "failed test")} (no run summary in the output)`);
  }

  return parts.length ? parts.join("; ") : "not recognised";
}

// True when the parse found something that explains a failure: the caller
// then trusts it over keyword matching.
export function hasFailureDetail(parsed) {
  return parsed.errors.length > 0 || parsed.tests.failures.length > 0 || parsed.crash.length > 0;
}

export function isRecognised(parsed) {
  return hasFailureDetail(parsed) || parsed.build.succeeded || parsed.build.failed || parsed.tests.verdict !== null;
}

export function reportsFailure(parsed) {
  return parsed.build.failed || parsed.errors.length > 0 || parsed.crash.length > 0 ||
    parsed.tests.verdict === "failed" || parsed.tests.verdict === "aborted" || parsed.tests.failures.length > 0;
}

// The selection used before this reader existed: lines that mention an error
// code, a failure, an exception or an assertion. Kept as the fallback for
// output in a shape the reader does not know.
export function keywordLines(text, { max = 50, extra = [] } = {}) {
  const selected = [];
  const seen = new Set();
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = stripAnsi(raw).trimEnd();
    if (!line.trim() || seen.has(line)) continue;
    if (
      /\berror\s+[A-Z]{1,5}\d{3,}\b/i.test(line) ||
      /\bfailed\b/i.test(line) ||
      /\bexception\b/i.test(line) ||
      /\bassert(?:ion)?\b/i.test(line) ||
      /\bTest Run Failed\b/i.test(line) ||
      extra.some((pattern) => pattern.test(line))
    ) {
      selected.push(line);
      seen.add(line);
      if (selected.length >= max) break;
    }
  }
  return selected;
}

// Failures whose first message line differs only in numbers and quoted text
// ("Expected:<7>" and "Expected:<9>") are one group.
function groupByFirstLine(failures) {
  const groups = new Map();
  for (const failure of failures) {
    const firstLine = failure.message[0] ?? "";
    const key = firstLine.replace(/'[^']*'|"[^"]*"/g, "''").replace(/\d+(?:\.\d+)?/g, "0");
    if (!groups.has(key)) groups.set(key, { firstLine, names: [] });
    groups.get(key).names.push(failure.name);
  }
  return [...groups.values()];
}

// A failed test as the TRX file records it: the full message and stack trace,
// independent of how the console printed them.
export function failureFromTrx({ name, message = "", stackTrace = "" }, { cwd = null } = {}) {
  const relative = makeRelativizer(cwd);
  const frames = String(stackTrace).split(/\r?\n/).map((line) => line.match(FRAME)?.groups).filter(Boolean);
  return {
    name,
    message: String(message).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, MAX_MESSAGE_LINES).map((line) => clip(line)),
    frame: chooseFrame(frames, relative)
  };
}

function makeRelativizer(cwd) {
  if (!cwd) return (value) => value;
  const roots = [String(cwd).replace(/[\\/]+$/, "")];
  return (value) => {
    const text = String(value);
    for (const root of roots) {
      for (const separator of ["/", "\\"]) {
        const prefix = `${root}${separator}`;
        if (text.startsWith(prefix)) return text.slice(prefix.length);
      }
    }
    return text;
  };
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function clip(text, max = MAX_LINE_CHARS) {
  const value = String(text);
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function stripAnsi(text) {
  return String(text).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}
