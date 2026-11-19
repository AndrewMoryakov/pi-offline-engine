# Code review 2026-09-23

Review of `main` at `c758b1f` (*Restore newlines in extension-contract test header*).

> **Read with the resolution at the end.** The review was written against
> `c758b1f`; `main` has since moved on by 57 commits, which split
> `extensions/index.ts` into modules, added the fake-Pi test harness and shipped
> 0.1.x. Every file and line number in the findings below refers to `c758b1f`.
> The resolution states, per finding, whether it still applied to the current
> tree, where the code had moved, and what closed it.

Method, and its limits, stated per finding. The P0 was established by reading the source and
by confirming the language rule that makes it fail; it was **not** reproduced by running the
real delegation path. The remaining findings were each checked against the code they describe.
This differs from `CODE_REVIEW_2026-09-21.md`, whose findings were all reproduced by execution
— the two documents do not carry the same weight of evidence.

Baseline: `npm test` → **153 tests, 152 pass, 0 fail, 1 skip**. The skip is the Windows
symlink-permission guard in `tests/verification.test.mjs`. A green suite is not evidence
against finding 1 — see finding 2 for why.

**Scope.** The code review covered `85d9c90^1..HEAD` — PR #7 plus the two follow-up commits —
because the working tree was clean and `HEAD` equalled `origin/main`, leaving no diff to review.
Documentation and packaging were audited across the whole repository. The remaining ~4000 lines
of `src/` (`verification.mjs`, `tiny-client.mjs`, `apply-candidate.mjs`, `offline-doctor.mjs`,
`training-*.mjs`, `repo-capsule.mjs`, and the scripts) were **not** reviewed in that pass — they
are covered by the second pass at the end of this document.

---

## P0

### 1. The bounded model-output retry is dead code and throws `ReferenceError`

`extensions/index.ts:539` reads `trainingRepairPacket` inside the `catch` that opens at line
532. The only declaration of that name is `extensions/index.ts:300`,
`const trainingRepairPacket = repairPacket;`, which sits inside the `try` opened at line 293.
A `const` declared in a `try` block is not in scope in its `catch`, so the reference throws
`ReferenceError: trainingRepairPacket is not defined`.

Trigger path: `callTinyImplementer` throws `TinyModelOutputError` on any malformed JSON envelope
or candidate — the most likely failure mode for a small local coding model. Control reaches the
catch, `canRetryModelOutput({ attempt, maxAttempts })` is `attempt < maxAttempts`
(`src/delegation-retry.mjs:1`) and so is true on attempt 1 of 3, and evaluating the object
literal at lines 536-540 throws from inside the error handler itself.

Consequences:

- the retry added by *"Allow bounded TinyCoder output retry after prior mutation"* never runs on
  its most common trigger;
- no `tiny_model_retry_scheduled` event is written;
- `buildModelOutputEscalation` never runs, so a designed escalation becomes an unhandled throw
  out of `execute()`;
- the main model receives no `workspaceModified` / `changedFiles` report — even when an earlier
  attempt already wrote to the workspace, which is the exact state that commit set out to handle.

Evidence: the declaration is unique (`grep -n trainingRepairPacket extensions/index.ts` → 300,
336, 358, 407, 482, 539; only 300 declares it); the try/catch boundary was read directly; the
language rule was confirmed with
`node -e "try { const t = 1; throw new Error('boom'); } catch (e) { try { console.log(t); } catch (err) { console.log(err.name); } }"`
→ `ReferenceError`. The sibling use at line 358 is inside the `try` and is fine.

Not done: no run of the real path. Reproducing it needs a local endpoint answering with a
malformed body plus a workspace that survives `preflightVerificationInfrastructure`.

Fix: declare it beside `let repairPacket = null;` at `extensions/index.ts:236`
(`let trainingRepairPacket = null;`) and assign at line 300.

---

## P1

### 2. No test drives the delegated-execution loop, so finding 1 passes every gate

`tests/delegation-retry.test.mjs` exercises only the pure helpers `canRetryModelOutput` and
`buildModelOutputRepairPacket`. `tests/extension-contract.test.mjs` greps the source text of
`extensions/index.ts` and asserts declarations exist. Neither enters the `for` loop at
`extensions/index.ts:292`, so a `ReferenceError` on its error path leaves 153 tests green.
`npm run check` cannot help either: `scripts/check-syntax.mjs` is a syntax check and the defect
is syntactically valid. `gate:pi` loads the extension but makes no LLM request, so it never
reaches the tool body.

This is the same blind spot that let `tests/extension-contract.test.mjs` sit broken from
`ce9910d` until `c758b1f`: the guards check that code parses and that declarations are present,
never that a path executes.

A regression test would stub `callTinyImplementer` to throw `TinyModelOutputError` and assert
that the loop schedules a retry, and that it returns the escalation outcome once attempts run
out.

### 3. `CODE_REVIEW_RESOLUTION_2026-09-21.md` documents a retry guard the code does not have

`docs/CODE_REVIEW_RESOLUTION_2026-09-21.md:30` states "invalid candidate schema/path/operation:
retry **while no workspace mutation occurred** and attempts remain", and line 18 says "bounded
cheap retries **before mutation**". `canRetryModelOutput` takes no `workspaceModified` argument;
in `src/delegation-retry.mjs` that name appears only inside `buildModelOutputEscalation` (lines
32 and 42). `docs/CODE_REVIEW_2026-09-21.md:199` describes the current behaviour, so the two
documents contradict each other on the retry policy.

### 4. Row 1 of the same resolution table asserts a validation that did not happen

`docs/CODE_REVIEW_RESOLUTION_2026-09-21.md:12` records "fixed invalid test syntax", and the
Validation section points at `npm test` and `npm run gate:local`. The same change shipped
`tests/extension-contract.test.mjs` with literal `\n` escapes that folded
`import test from "node:test"` into a comment, so that file threw `test is not defined` and the
suite was red on `main` until `c758b1f`. Row 10's `npm run check` claim is accurate but cannot
catch this class: the corrupted line remains a valid comment, so the syntax walker passes over a
dead test file.

### 5. README overstates what CI's install gate exercises

`README.md:325-330` presents `npm run gate:install` as running "the same `npm install --omit=dev`
pi runs for a git package". `.github/workflows/ci.yml:29` invokes it as
`npm run gate:install -- --package-dir .`, and `scripts/install-gate.mjs:47` performs that
install only under `if (!reusedPackageDir)`. In CI the production-tree install is therefore
skipped and the repository's dev tree is reused; the documented guarantee holds only for a local
run without the flag.

---

## P2

### 6. `/offline-stats` is undocumented

The command is registered at `extensions/index.ts:967`. README documents the other seven
`/offline-*` commands and never mentions this one; only `docs/ACCEPTANCE_V0.md` and
`docs/LOCAL_VALIDATION.md` refer to it.

### 7. `PI_KNOWLEDGE_SEARCH_PROFILE` is written but never named in the docs

`extensions/index.ts:116` sets the variable for the bundled pi-knowledge.
`docs/OFFLINE_PROFILE.md:13` only says the engine "sets the `low_token` search profile", so a
reader cannot discover the name in order to override it. The environment section at
`docs/OFFLINE_PROFILE.md:52-65` is where it belongs.

### 8. README describes a broader CI trigger than the workflow has

`README.md:304` says GitHub Actions runs the release gates "on pushes and pull requests". The
push trigger in `.github/workflows/ci.yml:5-8` is limited to `main` and `feat/**`, so a branch
named otherwise gets no push run.

Separately, every CI claim in the documentation is currently aspirational: Actions jobs in this
repository do not start at all. The API reports *"The job was not started because your account is
locked due to a billing issue"* for each run, including those for `9902484` and `85d9c90`. Until
that changes, `npm run gate:local` and `npm run gate:pi` are the only verification this project
actually has.

---

## Checked and cleared

- `argumentChoices` (`extensions/index.ts:999`) matches the `AutocompleteItem` shape pi-tui
  expects, and `getArgumentCompletions` returning `null` is allowed.
- `prior_repair_packet` nesting cannot grow without bound: `maxAttempts` is clamped to 3 in
  `src/engine-config.mjs`.
- Dropping the `workspaceModified` guard does not by itself defeat apply safety:
  `snapshotAllowedFiles` is re-taken per attempt and stale-preimage rejection still applies.
- Documented defaults (`127.0.0.1:8080`, `qwen2.5-coder-3b-instruct`, 3 attempts), the four
  discovery ports, the config and training paths, all ten npm scripts and the fixture paths match
  the code.
- `package.json` 0.0.16, its `overrides`, `bundledDependencies`, manifest entries and the lockfile
  pins are each enforced by `tests/packaging.test.mjs`.
- `llama.log` at the repository root is untracked, covered by `*.log`, and contains only
  llama.cpp token debug output — no credentials.

---

# Second pass — full `src/` and `scripts/`

The first pass above deliberately carried no verdict on most of `src/`. This second pass covers
it: five reviewers took one slice each (verification evidence, write safety, transport/config,
privacy/context data, orchestration and gates), executing the code where that was cheap.

Evidence markers below: **verified here** means re-executed or re-read directly while writing
this document; **executed by reviewer** means the reviewer ran it and the mechanism was
confirmed by reading the code; **read only** means nobody ran it.

## P0

### 9. The endpoint-locality check is fooled by a hostname, hiding that source leaves the network

`src/offline-doctor.mjs:134`. The private-range patterns are anchored only at their start and are applied to the
hostname rather than to a parsed address, so any name beginning with one passes. Verified here by calling `checkEndpointLocality`:
`http://192.168.evil.com/v1` and `http://127.0.0.1.evil.com/v1` both return local, with the
message "source stays on your network". This is the single control that tells a user their
prompts and `context.relevant_source` are being sent to a third party, and a crafted hostname
silences it while `/offline-doctor` still reports ready. Fix: match full dotted-quad addresses
and real loopback names, anchored.

### 10. Two spellings of one allowed file silently discard an edit and then report it as applied

`src/implementation-spec.mjs:21` dedupes `scope.allowed_files` by raw string;
`src/apply-candidate.mjs:18` keys its plan by `change.path`. `src/a.cs` and `./src/a.cs` (and,
on Windows, `SRC/A.CS` or `src\a.cs`) therefore become two plan entries, both computed from the
same original content, written in order — so the last write wins and the other edit vanishes.
Executed by reviewer: one of two required edits disappeared while `applyCandidate` returned
both paths in `changedFiles`. The engine then runs dotnet verification against a tree that is
missing a required change; if that build happens to pass, `verification_passed` evidence is
produced for work that was never applied. Fix: key scope and plan by the resolved absolute path
(case-folded on Windows) and reject a spec whose allowed files collide after resolution.

## P1

### 11. `npm run gate:local` passes on an extension that cannot load

`scripts/local-gate.mjs:13-37` runs syntax, unit tests, the profile dry-run and the transport
smoke. None of them loads the extension into Pi, and no unit test imports
`extensions/index.ts` — the contract test only greps its source text. Executed by reviewer in
an isolated `git archive` copy: with `throw new Error(...)` prepended to the extension,
`LOCAL GATE: PASS` while `gate:pi` failed. README presents `gate:local` as the canonical gate
and `gate:pi` as a separate follow-up. With CI unable to run, that wording invites shipping a
package that loads in no session at all. Fix: end `gate:local` with the pi-load gate.

### 12. No gate asserts the two tool names — the package's actual contract

`scripts/pi-load-gate.mjs:14` asserts three command names (`offline-setup`, `offline-doctor`,
`offline-status`) and nothing else. Verified here: `execute_delegated_implementation` and
`delegate_implementation` appear in `tests/` only as *fixture inputs* to
`tests/offline-doctor.test.mjs` and `tests/tool-profile.test.mjs`; no test or gate asserts that
the extension registers them. Executed by reviewer: renaming the registration at
`extensions/index.ts:185` left both `PI LOAD GATE: PASS` and `LOCAL GATE: PASS`. Compounding,
`src/tool-profile.mjs:42-43` matches those names as literals, so a rename also drops them from
`/offline-tools minimal` with no error. Five commands (`offline-context`, `offline-compact`,
`offline-tools`, `offline-training`, `offline-stats`) are likewise unasserted.

### 13. A verification failure can reach TinyCoder with no statement of what failed

Three defects compose, all executed by reviewer, mechanism verified here:

- `src/verification.mjs:200` and `:213` append the failure reason to the diagnostics and then
  take `.slice(0, 40)`. When the check already holds 40 lines, the reason itself
  ("zero tests executed", or the missing-pattern message) is the line that gets dropped.
- `src/verification.mjs:385` — `summarize` flattens every check's diagnostics and keeps the
  first 40. The build runs first, so a noisy but successful build crowds out the failing test's
  message.
- `src/repair-packet.mjs:17-27` projects each check into the packet without its `diagnostics`,
  so the truncated top-level list is the only failure text the model ever sees.

Together: the model is asked to repair a failure the packet does not describe. Fix: take the
last 40 rather than the first, and carry per-check diagnostics into the packet.

### 14. An API key that is not a recognised shape is persisted in cleartext

`src/tiny-client.mjs:91` redacts a non-OK response body before it is thrown and written to
`events.jsonl`, but `redactString` (`src/training-exporter.mjs:42-64`) matches known key
*shapes*. **Correction to the reviewer's report:** a genuine OpenRouter key is
`sk-or-v1-…` (README:111) and *is* redacted — I verified four shapes here:
`sk-or-v1-SECRET…` was replaced, while `or-v1-SECRET…`, `gw_tok_SECRET…` and a bare
`SECRET…` were persisted verbatim inside the 401 body. So the guarantee at README:124 holds
for OpenAI-shaped keys and fails for a self-hosted gateway, LiteLLM or any custom token. The
engine knows its own configured key; redact by value, not only by pattern.

### 15. `replace_text` uniqueness is counted without overlaps

`src/apply-candidate.mjs:78-88` — `countOccurrences` advances `offset` by `needle.length`, so
self-overlapping anchors are undercounted. Verified here by reading the loop: for content
`xaaay` and `expected: "aa"` the count is 1, the change is accepted as unique and applied at
the first match, although the anchor matches at two positions. The rejection message promises a
uniqueness guarantee the check does not provide.

### 16. An embedding model can be selected as the implementer

`src/endpoint-discovery.mjs:13` — `NON_CHAT_MODEL` filters only names containing `embed` or
`rerank`. Verified here: `pickChatModel(["bge-m3", "llama3"])` returns `bge-m3`.
`src/offline-doctor.mjs:179` only checks that the configured id appears in the catalog, so the
doctor reports ready for a model that cannot produce a candidate.

## P2

- `src/training-recorder.mjs:25-35` — `raw.jsonl` is written without redaction (`redactDeep`
  runs only in the exporter), while `/offline-training on` says sensitive captures are blocked
  automatically; the path gate is the only protection and it misses `.git-credentials`,
  `.npmrc`, `.netrc`, `.pgpass`, `id_ecdsa`, `id_dsa`, `*.jks`, `.envrc` and `.env/` used as a
  directory. Executed by reviewer.
- `src/tool-result-compactor.mjs:41-69` — 50 matching warning lines exhaust the diagnostic
  budget and a following `error CS0103` is dropped; the tail is only shown when nothing matched.
  For an xunit failure, `Expected:` / `Actual:` and the source-line frame are filtered out.
  Executed by reviewer.
- `src/training-exporter.mjs:56-67` — assignment redaction is single-line, so `api_key:` on one
  line with its value on the next survives into `eval.jsonl`. Executed by reviewer.
- `src/tiny-client.mjs:80` — the `json_object` fallback can fire on a genuine 500 whose body
  merely mentions `response_format`, and the surfaced error then describes the second attempt,
  losing the original cause. Executed by reviewer.
- `src/engine-config.mjs:120` — a wrong-typed value (`{"endpoint": 42}`) is silently replaced by
  the default with `error: null`, so `/offline-status` shows nothing wrong. Executed by reviewer.
- `src/apply-candidate.mjs:53,56` — directories created for a `create_file` are not removed on
  rollback, and `written.push` precedes the write, so the file whose write failed is reported
  as a rollback error although it was never modified. Executed by reviewer.
- `src/repair-packet.mjs:24` — `check.testPattern` is never assigned anywhere in `src/`.
  Verified here by grep: it is only read, in the packet and in
  `src/training-recorder.mjs:94`, so both always carry an empty field.
- Read only, not pursued: `src/verification.mjs:426` `escapeFilterValue` escapes `|` but not
  `&()!=` in a VSTest `--filter`; `DEFAULT_TIMEOUT_MS` is 120 s per command with no override
  from `extensions/index.ts:465`, so a cold large build is killed and reported as a verification
  failure the model cannot repair; `src/extension-policy.mjs` silently no-ops if Pi renames
  `selectedTools`.

## Checked and cleared in this pass

- No path was found that makes verification report **pass** when it should fail: missing or
  unparseable TRX, absent or zero `executed` counter, non-zero exit, killed process and both
  runner-misdetection directions all fail closed. `attachTrxEvidence` only downgrades.
- Workspace escapes fail closed: `..`, absolute Windows paths and UNC are rejected by
  `isSafeRelativePath` / `resolveInside`; stale-preimage rejection works.
- Config precedence (env > file > default) holds; the API key is never written to the config
  file; `maxAttempts` is clamped; timeout, external abort and a pre-aborted signal all terminate
  promptly; reverse-proxy path prefixes are preserved.
- Repo-capsule bounds and its data-not-instructions framing hold; `buildMinimalToolSet` and
  `applyCodeToolPolicy` match what `docs/OFFLINE_PROFILE.md` promises.
- Headless apply stays gated; the approval text lists exactly `scope.allowed_files`; a throwing
  event handler cannot break a session (Pi wraps handlers); auto-setup cannot raise an unhandled
  rejection.

---

# Resolution

The fixes were written against `c758b1f` and then carried onto the current `main`
(`406047d`), which had moved 57 commits ahead. Each one was re-verified there: every fix
ships with a test shown to fail without it on that tree, `npm run gate:local` passes with
318 tests, and `npm run gate:pi` loads the extension through the installed Pi. No CI result
exists for any of this — see finding 8.

Two findings had already been closed upstream by the refactor, and two more by the
documentation rewrite. They are recorded here rather than silently dropped.

| # | Status | Commit | Note |
|---|---|---|---|
| 1 | obsolete | — | The attempt loop moved to `src/delegation-execution-workflow.mjs`, where `priorRepairPacket` is an ordinary function binding. The defect does not exist there |
| 2 | closed upstream | — | `tests/helpers/extension-harness.mjs` now drives the real tool against a fake Pi, TinyCoder and dotnet, so the loop is exercised |
| 3 | corrected | `f206248` | Correction header on the 2026-09-21 resolution; its wording is kept as the record |
| 4 | corrected | `f206248` | Same header |
| 5 | corrected | `f206248` | README states that CI's `--package-dir .` skips the production install |
| 6 | closed upstream | — | `/offline-stats` is documented in the rewritten README |
| 7 | closed upstream | — | `PI_KNOWLEDGE_SEARCH_PROFILE` appears in the README environment table |
| 8 | corrected | `f206248` | Push trigger scope stated in both places; the billing lock itself is unchanged |
| 9 | fixed | `5cad4e3` | Ranges matched against four parsed octets. The rule had moved to `src/endpoint-locality.mjs` and gained a second consumer: `isLocalModel` in `src/edit-routing.mjs` decides hybrid edit routing, so a spoofed hostname could also bypass a cloud-only policy. Both consumers are now tested |
| 10 | fixed | `b021635` | Scope entries compared by filesystem identity; aliases rejected |
| 11 | partly fixed | `b7abb17` | `gate:local` now ends with the Pi load gate. On the current tree a load-time throw already fails the unit tests, so the step adds the real-host guarantee (manifest, Pi API, registration through the actual loader) rather than closing the hole described in the finding |
| 12 | fixed | `b7abb17` | The load gate asserts all eight commands. The tool names are asserted by the upstream registration test, so the test added on the old tree was dropped as a duplicate |
| 13 | fixed | `9c0fe00` | Verdict survives truncation, failed checks summarised first, per-check diagnostics carried into the packet. Six delegation goldens gained those lines |
| 14 | fixed | `1a33c6f` | Configured key removed by value before pattern redaction |
| 15 | fixed | `f4e6217` | Overlapping matches counted, so an ambiguous anchor is refused |
| 16 | fixed | `f4e6217` | Embedding and reranking families excluded from discovery |

Still open, all P2: unredacted `raw.jsonl` and the gaps in its sensitive-path gate; compactor
budget starvation; single-line-only export redaction; the `json_object` fallback masking an
original 500; silently discarded wrong-typed config values; rollback leaving created
directories and mislabelling the file whose write failed; `check.testPattern` never assigned;
and the read-only notes (VSTest filter escaping, the per-command verification timeout,
`selectedTools` renaming). These were found on `c758b1f` and have not been re-checked against
the current tree.
