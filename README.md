<p align="center">
  <img src="docs/assets/pi-offline-engine-hero.png" alt="pi-offline-engine: a big local model writes a spec, you approve it once, a tiny coder patches inside a bounded loop of build and tests, a red result goes back for repair, and still-red work returns to the big model" width="100%">
</p>

<h1 align="center">pi-offline-engine</h1>

<p align="center"><b>Make a local-model coding setup practical: an offline-first extension for the Pi coding agent that bundles readiness checks, bounded delegation of routine edits to a tiny local coder verified by real .NET build and tests, context and tool-output savings, a pinned companion tool stack, and opt-in training-data capture — all on your own machine.</b></p>

<p align="center">
  <a href="https://nodejs.org/"><img alt="Node.js 22.19+" src="https://img.shields.io/badge/Node.js-22.19%2B-339933.svg?logo=nodedotjs&logoColor=white"></a>
  <a href="#install"><img alt="Pi 0.86.1 verified" src="https://img.shields.io/badge/Pi-0.86.1%20verified-6E56CF.svg"></a>
  <a href="#current-vertical-slice"><img alt="Verification: dotnet build and test" src="https://img.shields.io/badge/verification-dotnet%20build%20%2B%20test-512BD4.svg?logo=dotnet&logoColor=white"></a>
  <a href="package.json"><img alt="Version 0.0.16" src="https://img.shields.io/badge/version-0.0.16-blue.svg"></a>
</p>

<p align="center"><b>English</b> | <a href="README.ru.md">Русский</a></p>

```bash
pi install git:github.com/AndrewMoryakov/pi-offline-engine
llama-server -m qwen2.5-coder-3b-instruct-q4_k_m.gguf   # the tiny implementer, listens on :8080
pi                                                      # then run /offline-doctor
```

`pi-offline-engine` is a Pi extension package for working with **local** language models, including with no network at all. One install brings the engine and four pinned companion extensions (retrieval, language server, code tool, lean edit). On top of them the engine adds: a readiness doctor and first-run endpoint discovery; two delegation tools that hand a precisely specified change to a much smaller local coding model and let real `dotnet build` / `dotnet test` decide whether it worked; a deterministic repository snapshot and compaction of large build output, so a slow model spends fewer tokens; a trimmed tool set for slow models; local telemetry; and an opt-in recorder that turns verified attempts into training data.

It is experimental (version 0.0.16, a Git-distributed Pi package, not on npm) and verification is **.NET-only** today. The [status and known limits](#status-and-known-limits) say exactly what has and has not been measured.

**Contents:** [In plain words](#in-plain-words) · [What's inside](#whats-inside) · [How it works](#how-it-works) · [Quick start](#quick-start) · [Install](#install) · [Delegation in depth](#current-vertical-slice) · [Configuration](#tiny-implementer) · [Safety](#safety) · [Offline operations](#offline-operations) · [Reference](#reference) · [Troubleshooting](#troubleshooting) · [Status](#status-and-known-limits) · [Docs map](#documentation-map)

## In plain words

### The problem

Running a coding agent on a local model is attractive: your code stays on your machine and it keeps working on a plane. But the best local models are big and slow. Every routine step — a small edit, a build, a failing test, another edit — costs a slow turn, floods the model's context window with compiler output, and gives a large model many chances to go off course. A local setup also has more moving parts than a hosted one: which server, which model, which search, which language server, and "will this still work when I disconnect?"

### Who it is for

Developers who use the Pi coding agent with a local main model (often slow), often on .NET code, often offline or about to be. Advanced users can tune the local server, the edit tools and the context budget, and can collect data to train a smaller model.

### What you get

- **A setup that works out of the box.** One `pi install` brings the engine and four companion extensions at exact pinned versions. On first start the engine looks for a local OpenAI-compatible server and saves it; `/offline-doctor` tells you whether you are ready before you lose the network.
- **Cheaper turns.** The big model writes one strict spec for a bounded change; a tiny local coder proposes the patch; the engine applies it exactly, runs the declared `dotnet build` and tests, and sends a compact failure summary back to the tiny coder — not the big model — for up to two repairs.
- **A smaller model-facing surface.** Large `dotnet build` / `dotnet test` output is compacted before it reaches the model, a small Git snapshot is added so early turns are not spent on orientation, and `/offline-tools minimal` trims the tool list for slow models.
- **Narrow blast radius.** You approve the declared file scope once; writes are exact and scope-checked, a file that changed in the meantime is rejected, and compiler and test results — not the model's opinion — decide.
- **Local evidence.** Telemetry, full build logs and candidate records stay in a gitignored `.pi/offline-engine/` directory, and you can opt in to capturing verified attempts as training data.

### What it is not

- Not a general-purpose coder for any stack: verification runs only `dotnet build` / `dotnet test`, and the repository documents no other toolchain.
- Not a substitute for review: `verification_passed` means only that the declared compiler and test checks passed, not that the task is semantically complete. The main agent must inspect the diff.
- Not a filesystem sandbox. The approved-file scope limits what the *candidate* may write; `dotnet build` and `dotnet test` then run in your repository with your permissions and can create files (for example under `bin`/`obj`) or run project build and test hooks.
- Not offline if you point the tiny implementer at a hosted router. That is possible but [is not an offline configuration](#hosted-openai-compatible-routers-openrouter).
- Not measured on a real local model yet: the real-model acceptance run has no recorded result (see [status](#status-and-known-limits)).

### Glossary

| Term | Meaning here |
|---|---|
| **Pi** | The terminal coding agent this package extends (npm package `@earendil-works/pi-coding-agent`). Extensions add tools, commands and hooks. |
| **Main model** | The large, slow local (or hosted) model you talk to in Pi; it reasons, plans and decides when work is done. |
| **TinyCoder / tiny implementer** | A much smaller model behind any OpenAI-compatible endpoint (for example a 3B coder GGUF on `llama-server`) that only produces bounded patches. |
| **ImplementationSpec** | The strict JSON the main model writes: target, requirements, allowed files (at most two) and the build/test to run. |
| **Candidate** | The TinyCoder's proposed patch: exact `replace_text` edits or an explicitly allowed `create_file`. |
| **Preimage / stale check** | A SHA-256 of each allowed file taken before every attempt; a candidate is refused if any of those files changed before it is applied. |
| **RepairPacket** | A compact description of a failed attempt (what was changed, selected diagnostics, log references) sent back to the TinyCoder. |
| **Escalation (`needs_main_model`)** | The result returned when the cheap loop cannot finish; control goes back to the main model. |
| **Capsule** | A small, deterministic Git snapshot injected as data before an agent run. |
| **TRX** | The test-result file format the engine requires as evidence that tests actually ran. |

## What's inside

Status labels: unlabeled = implemented in this repository; **experimental** = implemented but little-exercised or not measured end to end; **optional / deferred / planned** = not part of the default install.

### Bounded delegation (the core loop)

- **Two Pi tools.** `delegate_implementation` returns a candidate and writes nothing; `execute_delegated_implementation` runs the whole bounded loop. → [Delegation in depth](#current-vertical-slice)
- **Strict `ImplementationSpec` v1.** One operation (`modify_symbol`), a target file and symbol, requirements, optional `preserve` list, an allowed-file scope of at most two files, and the verification to run. → [ImplementationSpec v1](#implementationspec-v1)
- **Exact, guarded writes.** `replace_text` (the expected text must occur exactly once) and explicitly allowed `create_file`, after SHA-256 preimage, stale-file and symlink checks, through Pi's file mutation queue. → [Safety](#safety)
- **Deterministic .NET verification.** The engine builds `dotnet build` / `dotnet test` commands itself (the model cannot inject a shell command), with `--no-restore`, and requires TRX evidence that tests executed. → [Verification](#verification)
- **Cheap repair, then escalate.** Up to two repairs (three attempts in total) through a compact `RepairPacket`; invalid or non-JSON model output is retried the same way; anything unresolved returns `needs_main_model`. → [Repair and escalation](#repair-and-escalation)

### Offline readiness

- **`/offline-doctor`.** Checks the tiny endpoint and model, whether that endpoint is local, `dotnet`, the `dotnet test` runner mode, whether `.pi/offline-engine/` is git-ignored, optional `csharp-ls`, and which companion tools are loaded. → [Offline operations](#offline-operations)
- **First-run discovery and `/offline-setup`.** Probes loopback ports `8080`, `8081`, `1234` (LM Studio) and `11434` (Ollama) and saves the first server with a chat model. → [Tiny implementer](#tiny-implementer)
- **`/offline-status`.** Shows each effective setting and whether it came from the environment, the saved config or the default.
- **Offline checklist.** What to download, index and restore while still online. → [Recommended offline .NET companion stack](#recommended-offline-net-companion-stack)
- **Hosted router option.** The tiny-implementer slot also accepts a hosted OpenAI-compatible router such as OpenRouter; the doctor flags it as a non-offline configuration. → [Hosted routers](#hosted-openai-compatible-routers-openrouter)

### Fewer tokens for slow models

- **Tool-result compaction.** Large direct `dotnet build` / `dotnet test` shell output becomes selected diagnostics plus a path to the full log. `/offline-compact`. → [Tool-result compaction](#tool-result-compaction)
- **Repository context capsule.** A bounded Git snapshot (root, branch, HEAD, tracked dirty files, tracked `.sln`/`.slnx`/`.csproj`/`global.json`) added before an agent run. `/offline-context`. → [Repository context capsule](#repository-context-capsule)
- **Minimal tool set.** `/offline-tools minimal` keeps only the tools a slow model needs and `restore` brings the old set back. → [Offline operations](#offline-operations)
- **Local telemetry.** `/offline-stats` summarizes TinyCoder calls, tokens, latency, verification results, repair packets and characters kept out of model context. → [Files on disk](#files-on-disk)

### Companion stack (bundled, pinned)

- **pi-knowledge** (local retrieval), **pi-lsp-extension** (language-server semantics with Tree-sitter fallback), **pi-code-tool** (sandboxed Python composition over tools), **pi-lean-edit** (snapshot-backed range edits). All four are exact-pinned and loaded through this package's manifest. → [Companion stack](#recommended-offline-net-companion-stack)
- **`edit` provider control.** `editProvider` `lean` (default), `none` or `hybrid` (pi-lean-edit's edit becomes `line_edit` beside another package's `edit`), plus `scriptEditPolicy`. → [Another package that overrides `edit`](#another-package-that-overrides-edit)
- **Code-tool read-only rule.** When the `code` tool is active the engine adds prompt guidelines that keep it read-only; mutations go through the top-level edit/write tools or `execute_delegated_implementation`.
- **Optional / deferred.** `pi-sub-agent` (optional) and `pi-tree-sitter` (deferred) are installed only on request through the bootstrap script.

### Data and validation

- **Training-data capture** (off by default, **experimental**). Verified attempts can be recorded locally and exported as SFT, preference and eval datasets. `/offline-training`. → [Training-data capture](#training-data-capture)
- **Gates.** `gate:local`, `gate:pi`, `gate:edit`, `gate:install` and a production dependency audit. → [Canonical local gate](#canonical-local-gate)
- **Acceptance fixture.** A disposable .NET repository for a first controlled run. → [First real acceptance run](#first-real-acceptance-run)

### Not built yet

Post-edit Tree-sitter/LSP validation before build, code embeddings and reranking, 0.5B/1.5B implementer tiers and speculative decoding are **planned**; see [Next layers](#next-layers). Other harnesses (for example an MCP server) are only **proposed** in [docs/PROJECT_REVIEW_2026-10-01.md](docs/PROJECT_REVIEW_2026-10-01.md).

## How it works

The engine is one Pi extension (`extensions/index.ts`) over a Pi-independent core in `src/`. It adds two tools, eight slash commands and a few event hooks, and it loads four companion extensions next to it.

<p align="center">
  <img src="docs/assets/pi-offline-engine-how-it-works.png" alt="pi-offline-engine: a planner owl with a blueprint hands one step to a tiny coder, who lays bricks that only the tests check; a failed test means redo; the cloud is locked out and everything runs on the laptop" width="100%">
</p>

### The delegation loop

1. **The big model plans.** It writes a strict `ImplementationSpec` — scope, requirements and the build/test to run — and you approve the declared files once.
2. **The tiny coder proposes a patch.** The engine snapshots a SHA-256 of every allowed file, then asks the local TinyCoder for a candidate; if it lacks information it should return `insufficient_spec` rather than guess, and it may return `cannot_safely_implement`.
3. **The engine applies and verifies.** The candidate is validated, checked for staleness and applied exactly, then `dotnet build` and tests run with `--no-restore`.
4. **Red means repair, not a round trip to the big model.** A compact `RepairPacket` goes to the TinyCoder, up to two repairs; green yields `verification_passed` evidence, and a still-red result escalates to the main model.

### The rest of the session

| Pi hook or command | What the engine does | Section |
|---|---|---|
| `session_start` | Finds and saves a local server if none is configured; re-evaluates the hybrid `edit` policy | [Tiny implementer](#tiny-implementer) |
| `before_agent_start` | Adds the code-tool read-only guidelines; injects the repository capsule when it changed | [Repository context capsule](#repository-context-capsule) |
| `context` | Keeps only the latest capsule in model context | [Repository context capsule](#repository-context-capsule) |
| `tool_result` | Compacts large direct `dotnet build` / `dotnet test` shell output | [Tool-result compaction](#tool-result-compaction) |
| `/offline-*` commands | Doctor, setup, status, tools, context, compact, training, stats | [Commands](#commands) |
| Every step | Appends control metadata to `.pi/offline-engine/events.jsonl` | [Files on disk](#files-on-disk) |

## Quick start

Needs Pi 0.86.1 (the verified host baseline), Node.js 22.19.0 or newer, a local OpenAI-compatible server for the tiny coder, and the .NET SDK if you want delegation verified. Details, version pinning and the `edit` conflict cases are in [Install](#install).

```bash
pi install git:github.com/AndrewMoryakov/pi-offline-engine
llama-server -m qwen2.5-coder-3b-instruct-q4_k_m.gguf   # llama.cpp / ik_llama.cpp, listens on :8080
pi
```

On the first session start the engine finds the local server and saves it. Then confirm readiness inside Pi:

```text
/offline-doctor
```

From a clone, for development: `pi -e ./extensions/index.ts`. To try the pipeline on a disposable .NET fixture rather than your own repository, see [First real acceptance run](#first-real-acceptance-run).

## Install

One command installs the engine **and** its companion stack:

```bash
pi install git:github.com/AndrewMoryakov/pi-offline-engine
```

For reproducible team or travel installations, use a reviewed release tag or
commit instead of the moving default branch:

```bash
pi install git:github.com/AndrewMoryakov/pi-offline-engine@<release-tag-or-commit>
```

This is a Git-distributed Pi package (`private: true`); it is not published to
npm. The verified host baseline is **Pi 0.86.1** on **Node.js 22.19.0 or newer**.
The package keeps Pi core modules as `"*"` peer dependencies, as required by
Pi's package loader, while development and CI pin Pi 0.86.1 for reproducible
integration tests.

pi clones the repository and runs `npm install`, which brings in the four bundled companion extensions — `pi-knowledge`, `pi-lsp-extension`, `pi-code-tool`, `pi-lean-edit` — at exact pinned versions, all loaded through this package's manifest. See [docs/OFFLINE_PROFILE.md](docs/OFFLINE_PROFILE.md) for what each one does and which optional packages stay opt-in. Do not `pi install` the bundled four separately; that would register duplicate tools.

### Another package that overrides `edit`

pi-lean-edit registers `read`, `edit` and `write`. Pi refuses to start when two extensions register the same tool name, so a package with its own `edit` — for example `git:github.com/sting8k/pi-utils` — stops pi with `Tool "edit" conflicts with ...`. Pi gives extensions no view of other packages' tools while they load, so the engine cannot resolve this on its own; pick one provider, or run both side by side:

- keep pi-lean-edit and turn the other off — for pi-utils, add `"edit"` to `disabledTools` in `~/.pi/agent/pi-utils.json`;
- or keep the other one and set `"editProvider": "none"` in the engine config below (or `PI_OFFLINE_EDIT_PROVIDER=none`). pi-lean-edit's `read` and `write` go with it, since its `edit` only accepts ranges its own `read` has shown.

- or keep both: set `"editProvider": "hybrid"` (or `PI_OFFLINE_EDIT_PROVIDER=hybrid`) and leave the other `edit` on. pi-lean-edit's range edit is then registered as `line_edit`, and the other package keeps `edit`.

`/offline-doctor` shows which extension supplies `edit` and, when it is not pi-lean-edit, that `editProvider=none` is the reason. In hybrid mode it names the source of both tools and whether `edit` is currently offered.

#### Hybrid: which edit the model sees

The task statement, with where each rule came from, is [docs/HYBRID_EDIT_V0.md](docs/HYBRID_EDIT_V0.md).

`scriptEditPolicy` (config) or `PI_OFFLINE_SCRIPT_EDIT_POLICY` (env) decides when the other `edit` is offered next to `line_edit`:

- `always` (default): always offered. The model picks between the two tools from their descriptions.
- `cloud-only`: hidden while the session model's `baseUrl` is local (loopback, RFC1918, `.local`, a bare hostname), offered for a remote one. Re-evaluated at session start and on every model switch. A strong model reached through a local address, e.g. a tunnel on `127.0.0.1`, counts as local here.
- `never`: registered but never offered.

Hiding `edit` does not steer a model to `line_edit`. In a live run with the script edit hidden, a 27B model did an 11-file rename with `sed -i` through `bash`, which has neither `line_edit`'s stale-text check nor the script edit's diff and rollback. That is why the default is `always`; see `HE-10` in the task statement.

The policy only removes and restores `edit` itself; it never re-enables an `edit` you turned off, and `/offline-tools minimal` keeps it hidden. Tools that call Pi's built-ins directly, such as `pi-code-tool`'s bridge, are not governed by it (see [docs/OFFLINE_PROFILE.md](docs/OFFLINE_PROFILE.md)).

pi-lean-edit's edit schema is a union with no top-level `properties`, and ik_llama.cpp's tool-call parser returns such a tool's arguments empty. The engine therefore gives the model a flattened schema in both `lean` and `hybrid` modes; pi-lean-edit still rejects invalid combinations itself. See `HE-11`.

`npm run gate:edit` loads pi-lean-edit next to a fixture `edit` through the installed pi in each mode and checks the outcome, including that `lean` still refuses the pair.

### First start

Then start the TinyCoder server and open pi:

```bash
llama-server -m qwen2.5-coder-3b-instruct-q4_k_m.gguf   # llama.cpp / ik_llama.cpp, listens on :8080
pi
```

On the first session start the engine looks for a local OpenAI-compatible server on `127.0.0.1` ports **8080** (llama-server), **8081**, **1234** (LM Studio) and **11434** (Ollama), picks the first one serving a chat model — embedding and reranking models are skipped, coder models preferred — and saves it. You get one line saying what was configured, or what to start if nothing answered. Only loopback addresses are probed, so auto-configuration never points the engine at a remote host.

Confirm readiness:

```text
/offline-doctor
```

Pi extensions execute with user permissions. Review source before installation.

During development from a clone:

```bash
pi -e ./extensions/index.ts
```

## Current vertical slice

The delegation loop is the engine's core. Two Pi tools are provided:

- `delegate_implementation` — candidate-only; no writes.
- `execute_delegated_implementation` — bounded implementation loop with guarded writes and deterministic .NET verification.

The execute flow is:

```text
main local model
  -> strict ImplementationSpec
  -> one user approval for the declared file scope
  -> local TinyCoder
  -> exact candidate validation + stale-preimage check
  -> apply
  -> dotnet build/tests --no-restore
  -> compact RepairPacket on failure
  -> TinyCoder repair (up to two)
  -> verification_passed evidence or escalation to main model
```

The main model does not participate in the cheap repair loop. The tools carry prompt guidelines for the main model: delegate only after architecture and scope are decided, keep `allowed_files` at two or fewer, paste the exact relevant source into `context` (the engine does not read the files for the TinyCoder, and the tiny model is not a repository explorer), and call `execute_delegated_implementation` as the only mutating tool in its assistant turn so that sibling writes cannot contaminate verification. These are instructions to the model, not enforcement.

### Repair and escalation

- **Attempts.** A run makes at most 2 repair attempts after the first try, so at most 3 TinyCoder attempts in total. `PI_OFFLINE_TINY_MAX_ATTEMPTS` (or the saved `maxAttempts`) may lower this; it is capped at 3.
- **Repair on red.** When the build or declared tests fail, a compact `RepairPacket` (previous change paths and operations, build/test status, selected diagnostics, artifact references) goes back to the TinyCoder together with the original spec and context.
- **Invalid model output.** A reply that is not valid JSON or fails candidate validation is retried through a `model_output_failure` packet, using the same attempt budget.
- **What comes back.** `verification_passed` (compiler/test evidence only — the main agent must still inspect the diff), the TinyCoder's own `insufficient_spec` / `cannot_safely_implement` when nothing was changed, or `needs_main_model` with a `reason` such as `tiny_implementation_attempts_exhausted`, `tiny_invalid_output`, `tiny_transport_failure`, `verification_infrastructure_failure`, `verification_execution_failure` or `candidate_apply_failure`, plus the stage, whether the workspace was modified and the changed files.
- **Known boundary.** If verification is still red after the last attempt, the last candidate stays in the workspace and control returns to the main model. There is no automatic Git rollback or crash-safe transactional recovery.
- **Headless.** Mutating delegated execution needs interactive confirmation; without a UI it is refused unless `PI_OFFLINE_ALLOW_HEADLESS_APPLY=1` is set, which is meant only for a separately sandboxed workflow.

The runtime contract is in [docs/BOUND_DELEGATION_V0.md](docs/BOUND_DELEGATION_V0.md).

### Verification

The engine, not the model, builds the commands from `verification.build.project` and `verification.tests.project`, always with `--no-restore`. Test evidence must be a fresh TRX file with more than zero executed tests; exit code 0 alone is never enough. Test runners are detected per repository:

- **VSTest:** each declared test pattern runs on its own through `--filter` and TRX logging.
- **.NET 10 Microsoft.Testing.Platform (MTP):** the project suite runs once with `--report-trx`, and every declared pattern must appear among the executed TRX test identities. The test project must already provide `Microsoft.Testing.Extensions.TrxReport`, so restore it while you are still online.

A verification preflight runs before the TinyCoder is first called and fails closed if, for example, MTP is active but TRX reporting is unavailable. Full stdout/stderr and results are kept under `.pi/offline-engine/artifacts/`; only compact diagnostics are sent back through model context.

## Tiny implementer

The endpoint and model resolve in this order: **environment variable > saved config > built-in default** (`http://127.0.0.1:8080`, `qwen2.5-coder-3b-instruct`).

Saved config lives in `<pi agent dir>/pi-offline-engine/config.json` (normally `~/.pi/agent/pi-offline-engine/config.json`; `PI_CODING_AGENT_DIR` is honoured). It never stores API keys. Manage it with:

```text
/offline-setup                          # re-run discovery; asks which one if several servers answer
/offline-setup http://127.0.0.1:9000    # explicit endpoint, verified before it is saved
/offline-setup http://127.0.0.1:9000 my-model
/offline-setup reset                    # forget the saved endpoint/model
```

Each setup ends with the `/offline-doctor` report. Environment variables still win over the saved config — useful for scripts and one-off runs:

```bash
export PI_OFFLINE_TINY_ENDPOINT=http://127.0.0.1:8081
export PI_OFFLINE_TINY_MODEL=qwen2.5-coder-3b-instruct
export PI_OFFLINE_TINY_MAX_ATTEMPTS=3
```

If the endpoint includes a reverse-proxy path prefix, that prefix is preserved when resolving `health`, `v1/models`, and `v1/chat/completions`.

`/offline-status` shows the effective settings and where each value came from (environment, config file or default), whether the endpoint is local and whether a key is configured.

The implementer requests structured output with `response_format: json_schema` (strict, with optional fields sent as required-but-nullable so that strict validators should accept the schema — not yet exercised against a live hosted endpoint; the nulls are dropped again after parsing). llama-server (llama.cpp and ik_llama.cpp) supports it by compiling the schema to a grammar; if that conversion fails the server answers HTTP 500 with `JSON schema conversion failed`, and the engine retries once with `json_object`. The same single retry applies when a server or router reports the schema or `response_format` as unsupported or invalid. Sampling is `temperature: 0`, and each TinyCoder request has a 120-second timeout in the current code.

### Hosted OpenAI-compatible routers (OpenRouter)

The implementer slot accepts any OpenAI-compatible endpoint. A hosted router differs only in requiring a bearer token, so there is no provider switch — set a key and the `Authorization` header is sent:

```bash
export PI_OFFLINE_TINY_ENDPOINT=https://openrouter.ai/api/v1
export PI_OFFLINE_TINY_MODEL=qwen/qwen3-coder-30b-a3b-instruct
export PI_OFFLINE_TINY_API_KEY=sk-or-v1-...   # OPENROUTER_API_KEY is also honoured
```

Use the exact model id from `https://openrouter.ai/api/v1/models`; `/offline-doctor` verifies the configured id against that catalog. OpenRouter exposes no `/health`, so reachability rests on the model catalog alone.

Verify a real key end to end without touching a repository:

```bash
node scripts/smoke-tiny-transport.mjs --live
```

**This is not an offline configuration.** Prompts, spec text and the source excerpts in `context.relevant_source` are sent to a third party and on to whichever provider serves the model. `/offline-doctor` reports this as an `endpoint_locality` warning naming the receiving host; it is a warning rather than a readiness failure because the configuration is deliberate. Note that the locality check draws the line at your network, not at this machine — loopback, RFC1918 addresses and bare hostnames all count as local, so a LAN server is not flagged.

The key is only ever sent as an `Authorization` header. It is not written to `events.jsonl`, candidate records or training data, and a `401` body that quotes the key back is redacted before it is persisted. Redaction still applies only to what this engine writes to disk — it says nothing about what the router does with the source you send it.

## ImplementationSpec v1

Example:

```json
{
  "version": 1,
  "spec_id": "retry-001",
  "operation": "modify_symbol",
  "goal": { "summary": "Propagate cancellation into the retry delay." },
  "target": {
    "file": "src/Payments/RetryPolicy.cs",
    "symbol": "RetryPolicy.ExecuteAsync"
  },
  "requirements": [
    "Call ThrowIfCancellationRequested before every retry.",
    "Pass cancellationToken to Task.Delay."
  ],
  "scope": {
    "allowed_files": ["src/Payments/RetryPolicy.cs"],
    "allow_new_files": false,
    "allow_dependencies": false,
    "allow_public_api_change": false
  },
  "verification": {
    "build": { "project": "src/Payments/Payments.csproj" },
    "tests": {
      "project": "tests/Payments.Tests/Payments.Tests.csproj",
      "names": ["RetryPolicyTests.CancellationBeforeRetry"]
    }
  }
}
```

v1 delegation is intentionally limited to at most two files. In v1 `operation` must be `modify_symbol`, `target.file` must be one of `scope.allowed_files`, and an optional `preserve` array of non-empty strings states what must not change. The tool call also takes an optional `context` object, where the main model supplies the exact source the TinyCoder needs.

## Candidate format

Auto-apply supports only exact operations:

```json
{
  "status": "candidate",
  "changes": [
    {
      "path": "src/Payments/RetryPolicy.cs",
      "operation": "replace_text",
      "expected": "await Task.Delay(delay);",
      "content": "await Task.Delay(delay, cancellationToken);"
    }
  ]
}
```

or an explicitly allowed `create_file` (the spec must permit new files and the path must be in `scope.allowed_files`).

If the TinyCoder lacks enough information, it should return `insufficient_spec` instead of guessing; `cannot_safely_implement` is the third allowed status. Symbolic links and paths outside the workspace or scope are rejected. More semantic operations such as `replace_symbol` are not implemented; they would need a later Tree-sitter/Roslyn-backed slice.

## Safety

Before every TinyCoder attempt, SHA-256 is captured for every allowed file. A candidate is rejected as stale if any of those files changes before apply.

Mutations use Pi's file mutation queue, are scope-checked, and require interactive confirmation unless `PI_OFFLINE_ALLOW_HEADLESS_APPLY=1` is explicitly enabled in a controlled sandbox.

Full verification logs and candidate records stay under the gitignored `.pi/offline-engine/` directory. Test verification is runner-aware: VSTest uses targeted TRX runs, while .NET 10 Microsoft.Testing.Platform uses `--report-trx` and checks declared patterns against executed TRX identities.

| The engine guarantees | The engine does not guarantee |
|---|---|
| A candidate touches only files in the approved scope, by exact replacement or explicitly allowed creation | A filesystem sandbox: `dotnet build` / `dotnet test` run in your repository with your permissions and can create files (for example `bin`/`obj`) or run project build/test hooks |
| A file changed after the snapshot is not overwritten | That `verification_passed` means the task is semantically done — the main agent must inspect the diff |
| The model cannot inject a verification command | Rollback after a still-red final attempt |
| An API key never reaches the config file, `events.jsonl`, candidate records or training data | What a hosted router does with the source you send it |
| Training capture is off until you turn it on | That an exported dataset is safe to publish — review it first |

## Offline operations

Before disconnecting from the network:

```text
/offline-doctor
```

checks the configured TinyCoder endpoint/model, whether that endpoint is local, `dotnet` and its `dotnet test` runner mode (VSTest or MTP with TRX), whether `.pi/offline-engine/` is ignored by Git, optional `csharp-ls`, and whether the currently loaded Pi tool set contains the expected retrieval/LSP/code-mode/structural-navigation capabilities and the `edit` provider. The TinyCoder endpoint, `dotnet` and the `execute_delegated_implementation` tool are required; the rest are warnings.

If `.pi/offline-engine/` is not ignored, the doctor suggests adding `/.pi/offline-engine/` to the repository's `.git/info/exclude` so local artifacts are not accidentally staged.

For slow local models, reduce the tool schema exposed to the model:

```text
/offline-tools minimal
```

The profile prefers `code`, `knowledge_search`, and LSP tools when installed. If those are absent it retains Pi's built-in `grep/find/ls` fallbacks, and symbol-navigation tools stand in for LSP ones. `read`, `edit`/`line_edit`, `write`, one shell tool and the two delegation tools are kept.

Restore the previous tool set with:

```text
/offline-tools restore
```

`/offline-tools status` lists what the model can call right now. The full before-you-travel checklist is in [docs/OFFLINE_PROFILE.md](docs/OFFLINE_PROFILE.md).

## Tool-result compaction

Large `dotnet build` and `dotnet test` shell outputs are compacted before they enter the model context.

The full output is preserved under:

```text
.pi/offline-engine/tool-results/
```

The model receives selected compiler/test diagnostics (up to 50 lines), a small tail when no diagnostics are found, and the artifact path.

Compaction is enabled by default only for large (8,000 characters or more) results of a single direct `dotnet build` / `dotnet test` command run through the shell tool; pipelines and compound commands are left untouched. Control it with:

```text
/offline-compact on
/offline-compact off
/offline-compact status
```

or set `PI_OFFLINE_COMPACT_TOOL_RESULTS=0` before starting Pi.

## Repository context capsule

Before a local-model agent run, pi-offline-engine can inject a small deterministic Git snapshot:

- repository root;
- current branch and HEAD;
- tracked dirty files;
- tracked `.sln`, `.slnx`, `.csproj`, and `global.json` files.

This avoids spending early model turns on basic repository orientation. The snapshot is bounded (at most 30 dirty files and 30 project files are listed), stored as data rather than instructions, and only the latest capsule is sent in model context. It is re-sent only when the facts change, after a session compaction, or after navigating the session tree.

It is enabled by default. Control it with:

```text
/offline-context on
/offline-context off
/offline-context refresh
/offline-context status
```

Set `PI_OFFLINE_REPO_CAPSULE=0` to disable it at startup.

## Recommended offline .NET companion stack

The bundled four are pinned in `package.json` and described in full in [docs/OFFLINE_PROFILE.md](docs/OFFLINE_PROFILE.md):

| Package | Role | Tier |
|---|---|---|
| `pi-knowledge` 0.10.2 | Local-first BM25 + embeddings retrieval; the engine sets the `low_token` search profile unless you chose another | bundled |
| `pi-lsp-extension` 1.3.0 | Language-server semantics and diagnostics, plus Tree-sitter fallback for structural search and rewrite | bundled |
| `pi-code-tool` 0.6.1 | Sandboxed Python composition over tools, so loops and filtering do not cost a model turn each; read-only in this profile | bundled |
| `pi-lean-edit` 0.3.6 | `read`/`edit`/`write` with snapshot-backed range edits | bundled |
| `pi-sub-agent` 0.1.5 | Explicit scout/reviewer roles | optional |
| `pi-tree-sitter` 0.2.8 | Independent pre-write syntax guard; not loaded until qualified with pi-lean-edit | deferred |

`npm run profile:offline` is a dry run: it lists the bundled set and prints the environment for fully offline work; nothing is changed. The script only installs the non-bundled tiers, so a bare `--apply` installs nothing. After reviewing the package sources:

```bash
node ./scripts/bootstrap-offline-profile.mjs --apply --include-optional      # pi-sub-agent
node ./scripts/bootstrap-offline-profile.mjs --apply --install-csharp-ls     # csharp-ls; needs a .NET 10+ SDK
node ./scripts/bootstrap-offline-profile.mjs --apply --include-deferred      # pi-tree-sitter; not qualified yet
```

Set `PI_KNOWLEDGE_OFFLINE=1` for fully offline work only **after** pi-knowledge has downloaded its local embedding model (index one real repository while online first); set earlier, it blocks that download. The engine deliberately does not set it for you.

## Training-data capture

Verified TinyCoder attempts can be captured locally for future SFT, preference training and evaluation. The capture unit is the bounded implementation transaction (spec, bounded context, optional RepairPacket, candidate, verification label), not a chat transcript.

Capture is **off by default**:

```text
/offline-training on
/offline-training status
/offline-training export
/offline-training off
```

`/offline-training export` (or `npm run training:export`) writes `sft.jsonl`, `unpaired-preference.jsonl`, `paired-preference.jsonl` (only when the corpus holds both a verified and a failed candidate for the exact same prompt), `eval.jsonl` and a manifest under `.pi/offline-engine/training/export/`. Paths that look secret-bearing (`.env*`, credential/secret files, private keys) are skipped, strings are best-effort redacted and exact duplicates are dropped; the export is a safety filter, not a guarantee.

See [docs/TRAINING_DATA.md](docs/TRAINING_DATA.md) before enabling it: raw traces may contain private source code.

## Canonical local gate

The repository configures GitHub Actions to run the release gates on pushes and pull requests (see [status](#status-and-known-limits) for their current state). Run the same checks locally, starting with:

```bash
npm ci
npm run gate:local
npm audit --omit=dev --audit-level=high
```

`gate:local` checks syntax, runs the unit tests, dry-runs the offline-profile bootstrap and runs a TinyCoder transport smoke test against an in-process HTTP server.

The production tree currently overrides `sharp` to the audited 0.35.4 release
because the latest `pi-knowledge` still reaches an affected 0.34.x release
through `@huggingface/transformers`. The lockfile and packaging tests enforce
that override; do not remove it until the upstream dependency catches up.

It is designed to run without external network access. Then run:

```bash
npm run gate:pi
```

to load the extension through the actually installed Pi runtime without making an LLM request. It drives `pi --mode rpc` and requires the engine's commands to be registered, so an extension that throws while loading fails the gate. See [docs/LOCAL_VALIDATION.md](docs/LOCAL_VALIDATION.md).

`gate:pi` loads the engine alone, so it cannot see a clash with another package. For that, run:

```bash
npm run gate:edit
```

It loads `extensions/pi-lean-edit.ts` next to a fixture that registers its own `edit` in each `editProvider` mode, and fails if `lean` stops refusing the pair or if `none`/`hybrid` do not load as described above.

To check the whole turnkey path — the same `npm install --omit=dev` pi runs for a git package, then `pi install` into a throwaway agent dir, then `/offline-doctor` over RPC asserting the bundled companion tools are active — run (needs network for the npm step; your own `~/.pi` is not touched):

```bash
npm run gate:install
```

## First real acceptance run

A controlled disposable .NET fixture is included so the first TinyCoder run tests the pipeline rather than an arbitrary repository.

Prepare it while online:

```bash
npm run acceptance:prepare -- --restore
```

Then follow [docs/ACCEPTANCE_V0.md](docs/ACCEPTANCE_V0.md). The fixture has one localized bug and is meant to exercise the whole delegation pipeline, not to benchmark coding intelligence.

## Reference

### Commands

| Command | Purpose |
|---|---|
| `/offline-doctor` | Readiness report: TinyCoder endpoint and model, endpoint locality, `dotnet`, test-runner mode, Git-ignore of runtime state, `csharp-ls`, loaded companion tools, `edit` provider |
| `/offline-setup [endpoint [model]] \| reset` | Discover, set or forget the saved TinyCoder endpoint and model; ends with the doctor report |
| `/offline-status` | Effective settings with their source, locality, auth and attempt limit |
| `/offline-tools [status \| minimal \| restore]` | Trim the model-facing tool set for slow models, or restore it |
| `/offline-context [status \| on \| off \| refresh]` | Control the repository context capsule |
| `/offline-compact [status \| on \| off]` | Control compaction of large `dotnet` output |
| `/offline-training [status \| on \| off \| export]` | Control opt-in training-data capture and export |
| `/offline-stats` | Local telemetry summary |

Pi tools: `delegate_implementation`, `execute_delegated_implementation`.

### Environment variables

| Variable | Effect | Default |
|---|---|---|
| `PI_OFFLINE_TINY_ENDPOINT` | TinyCoder endpoint; overrides the saved config | saved config, else `http://127.0.0.1:8080` |
| `PI_OFFLINE_TINY_MODEL` | TinyCoder model id; overrides the saved config | saved config, else `qwen2.5-coder-3b-instruct` |
| `PI_OFFLINE_TINY_MAX_ATTEMPTS` | Total TinyCoder attempts (first try plus repairs), capped at 3 | 3 |
| `PI_OFFLINE_TINY_API_KEY` (or `OPENROUTER_API_KEY`) | Bearer key for a hosted router; never written to disk by the engine | none |
| `PI_OFFLINE_EDIT_PROVIDER` | `lean`, `none` or `hybrid` | `lean` |
| `PI_OFFLINE_SCRIPT_EDIT_POLICY` | Hybrid only: `always`, `cloud-only` or `never` | `always` |
| `PI_OFFLINE_COMPACT_TOOL_RESULTS` | `0` disables compaction at startup | on |
| `PI_OFFLINE_REPO_CAPSULE` | `0` disables the capsule at startup | on |
| `PI_OFFLINE_TRAINING_CAPTURE` | `1` enables capture at startup | off |
| `PI_OFFLINE_ALLOW_HEADLESS_APPLY` | `1` allows mutation without a UI; only in a separately sandboxed workflow | off |
| `PI_CODING_AGENT_DIR` | Pi agent directory that holds the saved engine config | `~/.pi/agent` |
| `PI_KNOWLEDGE_SEARCH_PROFILE` | pi-knowledge search profile; the engine sets `low_token` unless you chose one | `low_token` |
| `PI_KNOWLEDGE_OFFLINE` | pi-knowledge offline mode; set only after its embedding model is downloaded | unset |

`editProvider`, `scriptEditPolicy`, `endpoint`, `model` and `maxAttempts` can also be saved in the engine config file; the environment wins.

### Files on disk

| Path | Content |
|---|---|
| `<pi agent dir>/pi-offline-engine/config.json` | Saved endpoint, model, attempts, edit provider and policy; never an API key |
| `.pi/offline-engine/events.jsonl` | Control-metadata telemetry read by `/offline-stats` (no full source payloads) |
| `.pi/offline-engine/candidates/` | Candidate records, including generated patch content |
| `.pi/offline-engine/artifacts/` | Full build/test stdout, stderr and TRX results |
| `.pi/offline-engine/tool-results/` | Full output of compacted `dotnet` commands |
| `.pi/offline-engine/training/raw.jsonl` | Raw training traces (only when capture is on; may contain source) |
| `.pi/offline-engine/training/export/` | Exported datasets and manifest |

The repository's own `.gitignore` ignores `.pi/`; add `/.pi/offline-engine/` to a target repository's `.git/info/exclude`, which `/offline-doctor` checks.

### Project layout

| Path | Content |
|---|---|
| `extensions/index.ts` | The Pi extension: tools, commands and hooks |
| `extensions/pi-lean-edit.ts` | Loader that adapts the bundled pi-lean-edit per `editProvider` |
| `src/` | Pi-independent core: spec validation, TinyCoder client, apply, verification, repair, compaction, capsule, doctor, config, training |
| `scripts/` | Gates, bootstrap, training export, acceptance preparation, transport smoke test |
| `profiles/offline-dotnet-v1.json` | The pinned companion-package profile |
| `fixtures/` | Acceptance .NET fixture and an edit-conflict fixture |
| `tests/` | Node unit and extension-level tests |
| `docs/` | Design, validation, acceptance and review documents |

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Pi stops at startup with `Tool "edit" conflicts with ...` | Another package also registers `edit`. Pick one provider or use `hybrid`; see [Another package that overrides `edit`](#another-package-that-overrides-edit). |
| `/offline-doctor` reports the tiny endpoint down | Start the server, then run `/offline-setup`, or set `PI_OFFLINE_TINY_ENDPOINT`. Environment variables override the saved config. |
| Server answers HTTP 500 `JSON schema conversion failed` | The engine retries once with `json_object`; nothing to do. |
| `execute_delegated_implementation` is refused without a UI | Headless mutation needs `PI_OFFLINE_ALLOW_HEADLESS_APPLY=1`, only in a separately sandboxed workflow. |
| Doctor or preflight says MTP is active but TRX reporting is unavailable | Add `Microsoft.Testing.Extensions.TrxReport` to the test project and restore while online. |
| Doctor warns `.pi/offline-engine` is not ignored | Add `/.pi/offline-engine/` to `.git/info/exclude`. |
| pi-knowledge cannot download its embedding model | `PI_KNOWLEDGE_OFFLINE=1` was set before the first download; unset it, index a repository online, then set it. |
| `needs_main_model` | The cheap loop could not finish; read `reason` and `stage`. The last candidate may still be in the workspace if verification stayed red; inspect `git diff`. |
| A local model calls `line_edit` with empty arguments | The engine already flattens that schema for both `lean` and `hybrid` (HE-11); the remaining ik_llama.cpp parser bug that drops one leading space of a parameter value is documented there and not fixable in this package. |

## Status and known limits

Experimental. `pi-offline-engine` is at version 0.0.16 and is a Git-distributed Pi package (`private: true`, not published to npm).

- **Measured vs not.** The contract and helpers are covered by unit tests, extension-level tests with a fake Pi and fake TinyCoder, and the gates above. The real-model acceptance run ([docs/ACCEPTANCE_V0.md](docs/ACCEPTANCE_V0.md)) has no recorded result, and `docs/HYBRID_EDIT_V0.md` states that a real local llama-server has not been run for the hybrid evidence. Success rates of real TinyCoder implementations are therefore unknown.
- **CI.** The workflow in `.github/workflows/ci.yml` is configured to run `gate:local`, a production dependency audit, `gate:pi`, `gate:edit` and `gate:install` on pushes and pull requests. According to [docs/PROJECT_REVIEW_2026-10-01.md](docs/PROJECT_REVIEW_2026-10-01.md), hosted runs had not started, so the gates had only been run locally. Treat them as locally verified, not as continuously verified by CI.
- **Verification is .NET-only.** Other toolchains would need new engine-built runners.
- **Delegation limits.** At most two files, `replace_text`/`create_file` only, no symbol-level operations, no rollback after a red final attempt, and the main model must paste source into `context` by hand.
- **Verification is not semantic completion.** Inspect the diff.
- **Bundled packages** are third-party, pinned and loaded with your permissions; `pi-lean-edit` metrics key on the tool name `edit` and were not checked for `line_edit`; the `pi-tree-sitter` pre-write guard is not qualified with pi-lean-edit.
- **Proposed, not built.** Extracting the orchestration from `extensions/index.ts`, an MCP server or Claude Code plugin over the core, engine-side context attachment, pluggable verification runners and a frontier-model benchmark appear only as proposals in the project review.

## Next layers

Landed through the bundled companion stack (see [above](#recommended-offline-net-companion-stack)): local retrieval/context preparation (`pi-knowledge`), compact tool-result hooks (this engine's [compaction](#tool-result-compaction)), lean edit (`pi-lean-edit`) and part of the Tree-sitter/LSP structural tooling (`pi-lsp-extension`).

Still planned, after the delegation contract is measured on real tasks:

1. Tree-sitter/LSP post-edit validation before build;
2. specialized code embeddings + reranking;
3. smaller 0.5B/1.5B implementation tiers;
4. speculative decoding experiments for the main local model.

## Documentation map

| Document | What it covers |
|---|---|
| [docs/BOUND_DELEGATION_V0.md](docs/BOUND_DELEGATION_V0.md) | The delegation runtime contract |
| [docs/OFFLINE_PROFILE.md](docs/OFFLINE_PROFILE.md) | Companion stack, bootstrap, environment, offline checklist, C# language server, MTP note |
| [docs/HYBRID_EDIT_V0.md](docs/HYBRID_EDIT_V0.md) | The `hybrid` edit provider: task statement, constraints, evidence |
| [docs/TRAINING_DATA.md](docs/TRAINING_DATA.md) | Training capture, record contents, export formats, hygiene |
| [docs/LOCAL_VALIDATION.md](docs/LOCAL_VALIDATION.md) | What each gate establishes and does not establish |
| [docs/ACCEPTANCE_V0.md](docs/ACCEPTANCE_V0.md) | The first real machine-level acceptance run |
| [docs/PROJECT_REVIEW_2026-10-01.md](docs/PROJECT_REVIEW_2026-10-01.md) | Dated state review, open items and proposals |
| [docs/CODE_REVIEW_2026-09-21.md](docs/CODE_REVIEW_2026-09-21.md), [docs/CODE_REVIEW_RESOLUTION_2026-09-21.md](docs/CODE_REVIEW_RESOLUTION_2026-09-21.md) | An earlier code review and how its findings were resolved |

## Development

```bash
npm test
npm run check
```

See [docs/BOUND_DELEGATION_V0.md](docs/BOUND_DELEGATION_V0.md) for the runtime contract and [Canonical local gate](#canonical-local-gate) for the full pre-release checks.
