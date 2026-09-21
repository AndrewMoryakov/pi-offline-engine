# Code review 2026-09-21

Review of `main` at `c7572b0` (*Merge pull request #4 from AndrewMoryakov/feat/local-acceptance-harness-v0*).

Method: reading the sources plus running `node --test` and exercising individual functions on real inputs. Every finding below was reproduced by execution, not inferred.

Baseline: `npm test` → **71 tests, 69 pass, 1 fail, 1 skip**. The skip is an environment guard (`tests/verification.test.mjs:257`, Windows symlink permissions), not a disabled assertion.

---

## P0

### 1. `npm test` is broken on `main`, and the test never parsed

`tests/tool-result-compactor.test.mjs:16` was committed with literal `\n` escapes instead of newlines — three `assert.equal(...)` statements share one physical line:

```
assert.equal(isDotnetBuildOrTest("git status"), false);\n  assert.equal(...)
```

→ `SyntaxError: Invalid or unexpected token`; the module does not compile at all.

`git blame` attributes the line to `43af3d1` *"Test compound command compaction guard"*, an ancestor of `main` that arrived via the PR #3 merge.

Consequences:

- the assertions that commit claims to add have **never executed once**;
- `.github/workflows/ci.yml` runs `node --test` on push to `main` and on PRs, so CI on `main` is red — and PR #5 (`7865ea0`) and then PR #4 (`c7572b0`) were merged on top of the broken state;
- `npm run gate:local` dies on its first step (`unit tests`).

### 2. Fixing the syntax will not turn the test green — the specs contradict each other

Line 15 (which does parse) demands:

```js
assert.equal(isDotnetBuildOrTest("cd src && dotnet test App.Tests.csproj"), false);
```

The implementation returns `true`: the regex `(?:^|[;&|()]|\s)dotnet\s+(?:build|test)\b` deliberately permits a `[;&|()]` prefix — exactly what the test forbids. Decide what counts as "a dotnet command" before fixing.

### 3. Compactor swallows unrelated output

Verified by running `isDotnetBuildOrTest`:

| command | actual | expected |
|---|---|---|
| `dotnet build src/App.csproj --no-restore` | `true` | ✅ |
| `echo dotnet build` | `true` | ❌ |
| `rm -rf / ; dotnet build` | `true` | ❌ |
| `dotnet build \| tee build.log` | `true` | ❌ |
| `dotnet test && git status` | `true` | ❌ |

`compactToolResult` intercepts **any** shell tool result longer than 8000 characters whose command text mentions "dotnet build/test" anywhere, discards the real output, and hands the model a summary filtered by `/error|failed|exception|assert/i`. For `dotnet build | tee` or `dotnet test && <something>`, the second command's output is lost silently.

The original is written to `.pi/offline-engine/tool-results/`, but the model will not go looking: the summary says *"use the artifact only if the compact diagnostics are insufficient"*, and it cannot judge insufficiency — it has no original to compare against.

### 4. `String.replace` treats model output as a replacement pattern

`src/apply-candidate.mjs:38` — `entry.next.replace(change.expected, change.content)`. The second argument is a *string*, so `$$`, `$&`, `` $` ``, `$'` and `$n` in `change.content` are interpreted as replacement patterns. `change.content` is arbitrary text from the local model.

Verified:

| replacement | result on `int x = 1;` |
|---|---|
| `P$'Q` | `int x = P;Q;` |
| `A$&B` | `int x = A1B;` |
| `X$$Y` | `int x = X$Y;` |
| `() => "P$'Q"` (the fix) | `int x = P$'Q;` |

This **fails open**: the bytes on disk differ from the candidate that `validateCandidate` approved and `saveCandidateRecord` persisted as the audit record. If the mangled sequence lands inside a comment or string literal, build and tests still pass and `execute_delegated_implementation` reports `status: "verification_passed"` for source nobody wrote. `$` is common in C# interpolated strings and in regex literals, so this is not exotic. Fix: pass a function — `replace(change.expected, () => change.content)`.

### 5. Unguarded recursive delete of a user-supplied `--out` path

`scripts/prepare-acceptance-v0.mjs:19` — `await fs.rm(output, { recursive: true, force: true })` where `output` is `path.resolve(args[outIndex + 1])` (line 16). No existence check, no emptiness check, no confirmation.

`npm run acceptance:prepare -- --out .` recursively deletes the current working directory. The script is advertised in the docs as an ordinary developer command, and `--out` is its documented knob.

---

## P1

### 6. Secret redaction in `training-exporter.mjs` misses the most common forms

Running `redactString` on realistic shapes (verified):

| input | result |
|---|---|
| `api_key: abcdef123456` | ✅ redacted |
| `MY_API_KEY=abcdef123456789` | ❌ **leaks** |
| `AWS_SECRET_ACCESS_KEY=wJalr...` | ❌ **leaks** |
| `DB_PASSWORD=hunter2hunter2` | ❌ **leaks** |
| `{"api_key":"abcdef1234567890"}` | ❌ **leaks** |
| `Authorization: Bearer eyJ...` | ❌ **leaks** |
| `AKIAIOSFODNN7EXAMPLE` | ❌ **leaks** |
| `postgres://user:s3cretpw@host/db` | ❌ **leaks** |
| `sk-proj-AbCdEf...` | ❌ **leaks** |

*(All probe values above are synthetic or vendor-documented examples, not captured data.)*

Two concrete causes:

1. the `\b` before `api[_-]?key|secret|password` does not match after `_`, so the entire env-var family (`FOO_API_KEY=`, `AWS_SECRET_ACCESS_KEY=`) walks past;
2. in JSON a quote sits between the key and the `:`, while the regex requires `\s*[:=]` immediately after the word.

The `(?:sk|ghp|github_pat)_` rule only knows the underscore form, so current OpenAI keys (`sk-proj-`) are not caught.

Additionally, `hasSensitivePath` only inspects `spec.target.file` and `spec.scope.allowed_files`; paths inside the candidate itself (`candidate.changes[].path`) are not filtered.

Mitigating: `.pi/` is gitignored and capture is opt-in. But export exists precisely so the dataset can leave for fine-tuning — that is the moment the data leaves the machine. The *"redacts common secret assignments"* test passes because it only exercises the `key: value` form with a space.

### 7. The retry loop does not retry on the most likely failure

In `extensions/index.ts`, the `catch` at the end of the `for (let attempt = 1; attempt <= maxAttempts; ...)` body does `return`, not `continue`.

An invalid candidate throws `new Error("Tiny implementer returned an invalid candidate: ...")` inside the `try` → immediate escalation with zero retries. Only the verification-failure branch actually retries: it does not throw, it assembles a `repairPacket` and reaches the end of the iteration.

Meanwhile the tool description promises *"up to two cheap repair attempts"* and the UI prints `Attempts: up to ${maxAttempts}`. For a 3B model, a malformed JSON candidate is the single most likely outcome, and it is the one case that gets no retry.

Related: the failure is logged as `delegated_implementation_runtime_failure`, i.e. as infrastructure, when it is a model failure. The `if (trainingRunId && stage !== "candidate_validation")` workaround shows the classification is already straining.

### 8. Caller's `signal` is ignored when it is already aborted

`src/tiny-client.mjs:37` registers `signal?.addEventListener("abort", abort, { once: true })` with no preceding `aborted` check, and `fetch` receives `controller.signal`, not the caller's. Per spec, a listener added to an already-aborted signal never fires.

Scenario: the host aborts before `callTinyImplementer` is entered — a cancelled turn, or a repair attempt started right after cancellation — and the request runs for the full 120 s `DEFAULT_TIMEOUT_MS`. Needs `if (signal?.aborted) controller.abort(signal.reason);` immediately after registration.

### 9. Required readiness check fails open when the model catalog is unavailable

`src/offline-doctor.mjs:103` — `const exactModel = models.length === 0 || models.includes(model);`. When `/v1/models` throws or returns non-ok, `models` is `[]` and the model check passes unconditionally. `tiny_endpoint` is `required: true`, so `report.ready` becomes `true`.

Scenario: llama.cpp/Ollama answers `/health` but the configured `PI_OFFLINE_TINY_MODEL` is not loaded and no catalog is exposed — `/offline-doctor` prints "OFFLINE READY: yes" and the first `execute_delegated_implementation` dies at `stage: "tiny_call"`.

---

## P2

### 10. `npm run check` does not cover what actually broke

The script lists 23 files from `src/` and `scripts/` by name and includes neither `tests/` nor `extensions/`. That is exactly why an unparseable test sailed through `check`. The list is manual — easy to forget when adding a module. A `node --check` over a glob suggests itself.

### 11. `new URL(...)` discards the endpoint's path prefix

`new URL("/v1/chat/completions", ensureTrailingSlash(endpoint))` — a root-relative path resolves against the origin, so `http://host/openai/v1` becomes `http://host/v1/chat/completions`, and `ensureTrailingSlash` is dead code. Verified: `new URL('/v1/chat/completions', 'http://127.0.0.1:1234/api/v0/').href` → `http://127.0.0.1:1234/v1/chat/completions`.

`PI_OFFLINE_TINY_ENDPOINT` is documented as configurable, so pointing it at LM Studio's `/api/v0` or a reverse-proxied `/llm` makes every delegation POST the wrong path. `src/offline-doctor.mjs:89,95` repeats the pattern, so `/offline-doctor` reports a flat "unreachable" instead of diagnosing it. Use the relative form: `new URL("v1/chat/completions", ensureTrailingSlash(endpoint))`.

### 12. Over-broad detection of missing structured-output support

`looksLikeStructuredOutputUnsupported` matches `/json_schema|response_format|structured|grammar|unsupported|unknown/i` against the raw response body. Any 400/422 containing "unknown" — an unknown parameter, an unknown model — silently downgrades the request to `json_object` without schema validation: a quality regression whose only trace is the `structuredOutputMode` field.

### 13. `tests/extension-contract.test.mjs` asserts over source text, not behavior

Every test in the file reads `extensions/index.ts` as a string and runs `assert.match(source, /…/)`; nothing is imported or executed. *"TinyCoder nested usage is returned to Pi session accounting"* (line 34) merely checks that `usage: nestedUsage` and `toPiUsage(result.usage)` appear somewhere in the file.

This is not a style note: findings #1 and #3 reached `main` precisely because no test ever executed the compactor's guard.

---

## What is done well

`src/apply-candidate.mjs` is careful about transactionality: the file is registered in `written` **before** the write (the comment about partial overwrite is correct), rollback runs in reverse order, and rollback errors are collected into the final message. Finding #4 is a flaw in *what* it writes, not in how it sequences and unwinds the writes — the surrounding machinery is sound.

Also solid: `verifySnapshot` against a stale candidate, `replace_text` requiring exactly one occurrence, `resolveInside` against escapes from the root, `ctx.ui.confirm` plus the `hasUI`/`PI_OFFLINE_ALLOW_HEADLESS_APPLY` gate before any mutation, and best-effort training capture that swallows telemetry errors.

---

## Suggested order of work

1. **#4** and **#5** — both fail open or destroy data, both are one-line fixes.
2. **#3 + #1 + #2** — a single fix; only the compound-command spec needs deciding.
3. **#6** — widen the redaction rules and cover paths inside the candidate.
4. **#7** — decide between `continue` and explicit model-failure classification.
5. **#9**, **#8**, **#11** — small, self-contained correctness fixes.
6. **#10** and **#13** — so that this class of defect stops reaching `main`.

---

## Reviewed and deliberately not reported

- `escapeFilterValue` escaping only `|` — a malformed `--filter` makes `dotnet test` exit nonzero, so it fails closed.
- The mtp-vs-vstest expected-pattern asymmetry at `verification.mjs:206` — vstest runs one filtered invocation per pattern, and zero-executed is already caught at `:195`.
- The duplicate `before_agent_start` registration (`extensions/index.ts:518` and `:536`) — whether the host keeps one handler per event could not be verified here (`node_modules` absent).
