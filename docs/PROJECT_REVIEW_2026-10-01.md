# Project review — 2026-10-01

State of `pi-offline-engine` at `main@09fe1f2` (v0.0.16), what is still open,
and what could be done next, including running outside Pi and with hosted
frontier models. Each claim says how it was established.

## State

- `npm run check`, `npm test` (169 tests, 1 skipped), `gate:local` and
  `gate:pi` pass locally on Windows 11 with Pi 0.86.1 (run for this review).
- **GitHub Actions has never run a job in the visible history.** None of the
  last 100 runs succeeded. Every run finishes in 3–7 s. The newest
  (`36780536228`, 2026-09-30) and the oldest (`35530647791`, 2026-09-20, PR #2)
  both carry the annotation "The job was not started because your account is
  locked due to a billing issue"; the runs in between were not opened one by
  one. PRs up to #10 were merged on that red status, so the release gates the
  README describes have only ever run locally.
- The real-model acceptance run (`docs/ACCEPTANCE_V0.md`) has no recorded
  result: `fixtures/dotnet-boundary-v0/ACCEPTANCE_RESULT.template.json` is
  still only a template, and `HYBRID_EDIT_V0.md` states that a real local model
  (llama-server) has not been run. The README's "Next layers" are gated on
  measurements that do not exist yet.

## Fixed in this review

**`execute_delegated_implementation` threw on the first malformed TinyCoder
reply.** `trainingRepairPacket` was declared with `const` inside the attempt's
`try` and read in its `catch`. A reply that is not JSON, which is the most
likely failure from a 3B model, raised `ReferenceError: trainingRepairPacket
is not defined` out of the tool instead of retrying or escalating with
`tiny_invalid_output`. Reproduced with a fake TinyCoder, then fixed on
`fix/model-output-retry-scope`. The new `tests/extension-execute.test.mjs`
loads `extensions/index.ts` through Node's type stripping with a fake Pi API.
It fails with that `ReferenceError` on the old code and passes after the fix.
`extension-contract.test.mjs` only matches source text, so it could not catch
this.

This **reopens item #7 of `CODE_REVIEW_RESOLUTION_2026-09-21.md`**. That item
records malformed-output retry as fixed and covered, but its test exercised
only the pure `delegation-retry` module. The path through the extension never
worked at runtime until this fix.

## Open items

| # | Item | Evidence |
|---|---|---|
| O1 | CI blocked by a GitHub billing lock | run annotations, see above |
| O2 | PR #11 "flat edit schema" open, never CI-checked | `gh pr list`; see "Open PRs, checked locally" below |
| O3 | PR #12 README redesign (EN + RU) open | `gh pr list` |
| O4 | Acceptance v0 with a real local TinyCoder never run | template-only result file |
| O5 | pi-lean-edit metrics key on the tool name `edit`, not checked for `line_edit` | `HYBRID_EDIT_V0.md`, Out of scope |
| O6 | `pi-tree-sitter` pre-write guard deferred, not qualified with pi-lean-edit | `OFFLINE_PROFILE.md` |
| O7 | `docs/index-refactor-spec`: an unmerged, revised draft `docs/INDEX_REFACTOR_SPEC.md` (2026-09-25) for splitting `extensions/index.ts`, with no PR | `git log origin/main..origin/docs/index-refactor-spec` |
| O7b | `fix/code-review-2026-09-21` carries 8 commits not on main. Their subjects match work that landed through `fix/code-review-final-2026-09-21` (#7), so the branch is probably superseded; this was not diffed | `git log origin/main..` |
| O8 | Local Node 22.18.0 is below `engines` `>=22.19.0` | `node --version` |

## Open PRs, checked locally

CI cannot run (see State), so both open PRs were run here instead, on Windows
11 with Node 22.18.0 and Pi 0.86.1:

- **#11** `fix/flat-lean-edit-schema` @ `d0312ca`: `check` PASS, `npm test`
  172 pass / 0 fail / 1 skipped, `gate:edit` PASS, `gate:pi` PASS.
- **#12** `docs/readme-refresh` @ `c216f1f`: `check` PASS, `npm test`
  168 pass / 0 fail / 1 skipped.

Neither PR includes the fix above, and neither was run on Linux.

## Review findings (not fixed)

**F1. The strict `json_schema` is likely rejected by OpenAI-style strict
validators.** Status: plausible, not run against a live endpoint. The request
sends `strict: true`, but `reason` and `expected` are not listed in
`required`. OpenAI Structured Outputs requires every property to be listed,
as I understand its documentation. The error text I reconstructed for that
case ("Invalid schema for response_format ... 'required' is required to be
supplied ...") does not match `looksLikeStructuredOutputUnsupported`, so there
would be no `json_object` fallback: the call escalates with HTTP 400. This
does not affect llama-server. It matters as soon as the implementer slot
points at OpenAI, or at an OpenRouter model served by a strict provider. Fix:
make both fields required and nullable (`type: ["string","null"]`), or send
`strict: false` to non-local endpoints. Also add the "Invalid schema" wording
to the fallback detector.

**F2. The main model must paste source into `context` by hand.** The engine
does not read `scope.allowed_files` itself. The main model spends output
tokens echoing the file into the tool arguments, and a truncated echo makes
`replace_text` `expected` miss. With a paid frontier main model, that echo is
the largest avoidable cost of delegation. The engine already snapshots those
files, so it could attach their bounded contents itself.

**F3. Verification is .NET-only.** `verification.mjs` builds `dotnet`
commands from the spec. That is by design for v0, but it limits reuse. A
runner-plugin interface (dotnet / npm / cargo / pytest), still built by the
engine and never taken from model text, would keep the injection guarantee.

**F4. The orchestration in `extensions/index.ts` (about 1,075 lines) is mostly
untested.** The pattern in `tests/extension-execute.test.mjs` (fake Pi plus a
fake HTTP TinyCoder) can cover the remaining paths: invalid candidate then
retry, verification red then RepairPacket, stale preimage, the headless
refusal, and the cancel path.

## Portability: Claude Code and other harnesses

Nothing under `src/` imports Pi. Only `extensions/*.ts` touches the Pi API
(`registerTool`, `ctx.ui.confirm`, `withFileMutationQueue`, `pi.exec`, event
hooks). The core is portable. What is missing is an adapter per harness.

Claude Code facts below come from the Claude Code docs (code.claude.com/docs:
mcp, hooks, plugins, sub-agents, third-party-integrations), as summarised by a
docs lookup during this review. I have not tested them here.

| Engine feature | Claude Code / generic equivalent |
|---|---|
| `delegate_implementation`, `execute_delegated_implementation` | stdio **MCP server** wrapping `src/`. Works in Claude Code, Codex, Cursor, Gemini CLI and any other MCP client |
| scope confirmation (`ctx.ui.confirm`) | MCP **elicitation**, or the client's own tool-permission prompt. Headless `claude -p` does not prompt, so keep the `PI_OFFLINE_ALLOW_HEADLESS_APPLY` rule |
| `withFileMutationQueue` | none across processes. The SHA-256 stale-preimage check still refuses a raced candidate |
| `pi.exec` | `child_process.execFile` (no shell) |
| dotnet output compaction (`tool_result`) | PostToolUse hook with `updatedToolOutput` on `Bash` (per the docs, not tested here) |
| repo capsule (`before_agent_start`) | SessionStart / UserPromptSubmit hook with `additionalContext` |
| `/offline-tools minimal` | `permissions.deny` / `--tools`. Rarely needed with a frontier model |
| `/offline-doctor`, `/offline-status`, `/offline-stats` | MCP tools, plus plugin slash commands |
| packaging | a Claude Code **plugin**: `.claude-plugin/plugin.json` + `.mcp.json` + `hooks/hooks.json` + a skill describing when to delegate |

Limits:

- Claude Code subagents accept only Claude models, so an MCP tool is the only
  way to reach a local TinyCoder from Claude Code.
- Claude Code's own main model can be routed through `ANTHROPIC_BASE_URL` to a
  gateway such as LiteLLM, but a local llama.cpp model is not documented as
  supported. Treat "Claude Code fully offline" as out of scope.

### Frontier main model + cheap implementer

The contract (spec in, verified candidate out) does not depend on the size of
the main model. With Claude, GPT or Gemini as the reasoner and a local or cheap
hosted coder as the implementer, the engine becomes a cost-saving delegation
layer rather than an offline one. Pi already lets the main model be a hosted
provider, and the implementer slot already accepts OpenRouter. The gaps are
F1 (strict schema), F2 (source echo cost) and the absence of a measured
comparison. The existing `/offline-stats` telemetry is enough to produce one.

## Proposed tasks

Ordered by value per effort.

1. **Restore CI** (resolve the billing lock, or move the gates to a
   self-hosted runner), then re-run the gates on `main`, #11 and #12.
2. Merge `fix/model-output-retry-scope`, then decide on #11 and #12.
3. **F1**: make the candidate schema strict-valid and extend the fallback
   detector. Add a transport test with the OpenAI error body.
4. **Run acceptance v0** with a real llama-server TinyCoder and commit
   `ACCEPTANCE_RESULT.json`. Everything in "Next layers" waits on this.
5. **F2**: engine-side context. Attach the bounded contents of
   `allowed_files` (and the target symbol, via LSP/Tree-sitter when present)
   so the main model sends only the spec.
6. **F4**: extend extension-level behavioral tests to every exit path of
   `execute_delegated_implementation`.
7. **Extract the orchestration** from `extensions/index.ts`, following the
   existing draft `docs/INDEX_REFACTOR_SPEC.md` on `docs/index-refactor-spec`
   (O7): a runner with injected `exec`, `confirm`, `mutationQueue` and `log`.
   This is the prerequisite for any other harness.
8. **MCP server** (`bin/pi-offline-mcp.mjs`) over that runner: the two
   delegation tools, plus doctor, status and stats.
9. **Claude Code plugin**: MCP server, a Bash compaction hook, a SessionStart
   capsule hook, and a skill telling the model when a bounded spec is worth
   delegating.
10. **Frontier benchmark**: the same fixture, main model Claude/GPT with and
    without delegation. Record tokens, cost, wall time and pass rate.
11. **Pluggable verification runners** (F3), starting with `npm test` and
    `cargo test`.
12. Close O5 (lean-edit metrics under `line_edit`) and O7b (delete the superseded branch once its diff is checked).
