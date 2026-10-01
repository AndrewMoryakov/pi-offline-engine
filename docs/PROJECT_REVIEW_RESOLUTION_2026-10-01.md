# Project review resolution — 2026-10-01

Disposition of `PROJECT_REVIEW_2026-10-01.md`. The review itself is left
unchanged. GitHub Actions still cannot run (billing lock; the owner decided to
work around it, not fix it). Every PR below was verified with local gates on
Windows 11, Node 22.18.0, Pi 0.86.1 and .NET 10.0.301, and the results are
recorded in each PR description.

## Findings and open items

| Item | Status | Where |
|---|---|---|
| Malformed TinyCoder output threw `ReferenceError` (reopened resolution #7 of 2026-09-21) | fixed; regression test fails on the old code | #13 |
| O1 CI billing lock | worked around: local gates are the evidence; CI workflow kept current (now includes `gate:dotnet`) | #17 |
| O2 PR #11 flat edit schema | merged after local `check`/`test`/`gate:edit`/`gate:pi` | #11 |
| O3 PR #12 README redesign | merged; flat-schema note carried into README.ru | #12 |
| O4 acceptance with a real local model | **open**; see "Not done" | — |
| O5 lean-edit metrics under `line_edit` | open | — |
| O6 pi-tree-sitter guard | open (deferred by design) | — |
| O7 index refactor spec | implemented; spec branch deleted | #19 |
| O7b `fix/code-review-2026-09-21` | superseded (every test it added exists on main under another name, the doctor TRX warning deliberately moved to preflight); deleted | — |
| O8 local Node below `engines` | open (environment) | — |
| F1 strict `json_schema` rejected by strict validators | fixed; strict-rules checker plus a test that it rejects the old shape; LM Studio accepts the new schema. **Not verified against live OpenAI:** the sandbox's network policy answered 403 | #14 |
| F2 main model echoes source into `context` | fixed: `current_files` attached per attempt from the hashed bytes, ≤16 KB/file | #22 |
| F3 .NET-only verification | open; needs its own spec (see "Not done") | — |
| F4 orchestration untested | fixed: Phase 0 characterization goldens for every transition, plus workflow tests | #19 |

## Found and fixed during the follow-up

| Defect | How it was found | Where |
|---|---|---|
| Project-qualified `dotnet test --help` took 18–23 s against a 10 s runner-detection limit, so every execute with tests failed preflight on this workstation | end-to-end run on the acceptance fixture with real dotnet | #15 |
| `OPENROUTER_API_KEY` was sent as a bearer token to any endpoint (local, LAN or third-party) | live Claude Code run: status said "bearer key configured" for 127.0.0.1 | #20 |
| Fixed 120 s implementer timeout too short for slow local hardware | LM Studio probe (about 52 s for 3 tokens) | #23 (`PI_OFFLINE_TINY_TIMEOUT_MS`, 5–300 s) |

Fake-exec unit tests hid two of these runtime defects: the `ReferenceError`
and the timeout. `npm run gate:dotnet` (#17) now drives the real extension
through real dotnet build/test, the malformed-output retry and one red-test
repair. Breaking the extension the way 09fe1f2 was broken makes it fail. It
did not reproduce the timeout on a warm build, so timing defects remain
machine-dependent.

## Portability delivered

- **Refactor** (#19): `extensions/index.ts` went from 1,077 to 26 lines. The
  workflows in `src/delegation-*.mjs` have no Pi imports and receive every
  capability explicitly.
- **MCP server** (#21): `mcp/server.mjs` needs no npm install. It exposes the
  two delegation tools plus doctor, status and stats.
  - Workspace: `PI_OFFLINE_WORKSPACE`, then `CLAUDE_PROJECT_DIR`, then MCP
    roots. It is never the process cwd.
  - Approval is one elicitation and fails closed.
- **Claude Code plugin** (#21): the repository is its own marketplace. It ships
  the MCP server, the dotnet compaction and repository-snapshot hooks, and the
  `bounded-delegation` skill. See `docs/CLAUDE_CODE.md`.

What was observed in Claude Code 2.1.286, as opposed to read in its docs:

- `updatedToolOutput` for Bash only applies in `tool_response` shape.
- `claude -p` advertises elicitation but cancels it, and nothing is written.
- With `--plugin-dir`, a scripted implementer and the headless switch, Haiku
  wrote the spec and the plugin's MCP server returned `verification_passed`
  on attempt 2 (4/4 tests).
- The server and hooks run from a clean `git archive` with no `node_modules`.

- Under `--plugin-dir`, the SessionStart hook put the repository snapshot into
  the model's context: Branch/HEAD quoted correctly.
- Under `--plugin-dir`, the PostToolUse hook compacted a 298,939-character
  `dotnet build -v d` result to 879 characters. This only worked after 0.1.1:
  Claude Code passes large results with `persistedOutputPath`, and 0.1.0 kept
  that key, so the model still saw the original.

Not observed: the interactive elicitation dialog in the TUI, installation
through `/plugin marketplace add` (only `--plugin-dir` was used), and MCP
clients other than Claude Code.

## Not done, and why

- **O4 / task 10, real-model acceptance and the frontier benchmark.** This
  workstation has no GPU. The only loaded local model (a 42B MoE in LM Studio)
  took about 52 s for 3 tokens. Hosted models were unreachable because the
  sandbox's network policy returned 403 for OpenRouter. The scripted runs above
  are component evidence, not acceptance. Run `docs/ACCEPTANCE_V0.md` on a
  machine that can serve a 1.5–3B coder model, and compare token use with
  `offline_stats` / `/offline-stats`.
- **F3, pluggable verification runners.** Verification proves execution with
  TRX (executed > 0, every declared pattern found). An npm/cargo/pytest runner
  needs an equivalent evidence rule per ecosystem before any code is written,
  so it needs a spec of its own.
- **Minor defects pinned by the #19 goldens** (each fix will show as a
  deliberate golden change):
  1. A throwing progress callback is classified by the previous stage.
  2. The sensitive-path training event is written before the headless refusal
     or confirmation.
  3. A failing `tiny_terminal_status` write is reported as
     `tiny_invalid_candidate`.
  4. A candidate-only storage failure is reported as "Tiny implementer failed".
  5. An unwritable ledger rejects with a raw fs error.
  6. `attempts` is a number in content but an array in details on exhaustion.
  7. Preflight-failure results lack a `usage` key.
- **Pi path in foreign repositories.** The Pi extension still creates an
  unignored `.pi/` there. Only the MCP server and the Claude Code hooks call
  `ensureSelfIgnoringStateDir`.
- **PR #16** (README in layers) belongs to a parallel session and was left
  alone. #18 removed README lines that would otherwise have conflicted with it.
