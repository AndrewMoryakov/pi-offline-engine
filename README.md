<p align="center">
  <img src="docs/assets/pi-offline-engine-hero.png" alt="pi-offline-engine: a big local model writes a spec, you approve it once, a tiny coder patches inside a bounded loop of build and tests, a red result goes back for repair, and still-red work returns to the big model" width="100%">
</p>

<h1 align="center">pi-offline-engine</h1>

<p align="center"><b>A big local model plans, a tiny local model codes, real .NET build and tests decide — all on your own machine. An offline-first extension for the Pi coding agent.</b></p>

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

Offline-first extension experiments for the Pi coding agent.

The project explores a compound local coding system where a large local model is reserved for reasoning and architecture, while deterministic tools and a much smaller local coding model perform bounded implementation work.

## Why pi-offline-engine?

- **If** your main local model is big and slow, **then** you do not want to spend its turns on routine edits and build-fix cycles: it writes a strict spec, a tiny local coder does the bounded implementation, and the big model stays out of the cheap repair loop.
- **If** you work offline or are about to disconnect, **then** everything runs on your machine: the engine discovers a local OpenAI-compatible server on loopback, and `/offline-doctor` tells you whether you are ready before you lose the network.
- **If** you do not trust a small model with your repository, **then** the blast radius is narrow: you approve the declared file scope once, writes are exact and scope-checked, a stale file is rejected, and real `dotnet build` / `dotnet test` results decide — not the model's opinion.
- **If** you want a working local setup without assembling it, **then** one `pi install` brings the engine and four pinned companion extensions (retrieval, LSP, code tool, lean edit).

It is **not** a general-purpose coder for any stack: verification today is .NET-only (`dotnet build` / `dotnet test`), and the repository documents no other toolchain. It is not a substitute for review — a `verification_passed` result means only that the declared compiler and test checks passed, not that the task is semantically complete, so the main agent must inspect the diff. It is a Git-distributed Pi package (`private: true`), not on npm, and still experimental. Pointing the tiny implementer at a hosted router is possible but [is not an offline configuration](#hosted-openai-compatible-routers-openrouter). The approved-file scope limits what the candidate may write; it is not a filesystem sandbox, because `dotnet build` and `dotnet test` then run in your repository with your permissions and can create files (for example under `bin`/`obj`) or run project build and test hooks.

## Features

- **Two Pi tools** — `delegate_implementation` (candidate only, no writes) and `execute_delegated_implementation` (bounded loop with guarded writes and deterministic verification).
- **Strict `ImplementationSpec` v1** — operation, target, requirements, allowed-file scope and verification declared up front; delegation is limited to at most two files.
- **One approval, exact writes** — the user approves the declared file scope once; a candidate is applied only as an exact `replace_text` or an explicitly allowed `create_file`, after SHA-256 preimage and stale checks.
- **Deterministic .NET verification** — `dotnet build` / tests with `--no-restore`; VSTest uses targeted TRX runs and .NET 10 Microsoft.Testing.Platform uses `--report-trx`.
- **Cheap repair loop** — on failure a compact `RepairPacket` goes back to the TinyCoder (up to two repairs); if it is still red the work is escalated to the main model.
- **Turnkey companion stack** — `pi-knowledge`, `pi-lsp-extension`, `pi-code-tool` and `pi-lean-edit` come pinned and are loaded through this package's manifest.
- **Offline operations** — `/offline-doctor`, `/offline-setup`, `/offline-tools minimal`, compaction of large `dotnet` output, and a deterministic repository context capsule.
- **Nothing leaves quietly** — an API key is never saved to the config file, `events.jsonl`, candidate records or training data, and training-data capture is off unless you turn it on.

## How it works

<p align="center">
  <img src="docs/assets/pi-offline-engine-how-it-works.png" alt="pi-offline-engine: a planner owl with a blueprint hands one step to a tiny coder, who lays bricks that only the tests check; a failed test means redo; the cloud is locked out and everything runs on the laptop" width="100%">
</p>

1. **The big model plans.** It writes a strict `ImplementationSpec` — scope, requirements and the build/test to run — and you approve the declared files once.
2. **The tiny coder proposes a patch.** The engine snapshots a SHA-256 of every allowed file, then asks the local TinyCoder for a candidate; if it lacks information it should return `insufficient_spec` rather than guess.
3. **The engine applies and verifies.** The candidate is validated, checked for staleness and applied exactly, then `dotnet build` and tests run with `--no-restore`.
4. **Red means repair, not a round trip to the big model.** A compact `RepairPacket` goes to the TinyCoder, up to two repairs; green yields `verification_passed` evidence, and a still-red result escalates to the main model.

## Quick start

Needs Pi 0.86.1 (the verified host baseline), Node.js 22.19.0 or newer, and a local OpenAI-compatible server for the tiny coder. Details, version pinning and the `edit` conflict cases are in [Install](#install).

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

## Current vertical slice

Two Pi tools are provided:

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

The main model does not participate in the cheap repair loop.

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

The implementer requests structured output with `response_format: json_schema`. llama-server (llama.cpp and ik_llama.cpp) supports it by compiling the schema to a grammar; if that conversion fails the server answers HTTP 500 with `JSON schema conversion failed`, and the engine retries once with `json_object`.

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

v1 delegation is intentionally limited to at most two files.

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

or an explicitly allowed `create_file`.

If the TinyCoder lacks enough information, it should return `insufficient_spec` instead of guessing.

## Safety

Before every TinyCoder attempt, SHA-256 is captured for every allowed file. A candidate is rejected as stale if any of those files changes before apply.

Mutations use Pi's file mutation queue, are scope-checked, and require interactive confirmation unless `PI_OFFLINE_ALLOW_HEADLESS_APPLY=1` is explicitly enabled in a controlled sandbox.

Full verification logs and candidate records stay under the gitignored `.pi/offline-engine/` directory. Test verification is runner-aware: VSTest uses targeted TRX runs, while .NET 10 Microsoft.Testing.Platform uses `--report-trx` and checks declared patterns against executed TRX identities.

## Development

```bash
npm test
npm run check
```

See [docs/BOUND_DELEGATION_V0.md](docs/BOUND_DELEGATION_V0.md) for the runtime contract.

## Status

Experimental. `pi-offline-engine` is at version 0.0.16 and is a Git-distributed Pi package (`private: true`, not published to npm). The bounded-delegation contract is still to be measured on real tasks before the layers listed under [Next layers](#next-layers) are built. GitHub Actions runs the release gates (`gate:local`, a production dependency audit, `gate:pi`, `gate:edit`, `gate:install`) on pushes and pull requests; see [Canonical local gate](#canonical-local-gate).

## Next layers

After this contract is measured on real tasks:

1. Tree-sitter/LSP post-edit validation before build;
2. local retrieval/context preparation;
3. compact tool-result hooks;
4. lean edit / structural transformation;
5. specialized code embeddings + reranking;
6. smaller 0.5B/1.5B implementation tiers;
7. speculative decoding experiments for the main local model.


## Offline operations

Before disconnecting from the network:

```text
/offline-doctor
```

checks the configured TinyCoder endpoint/model, `dotnet`, optional `csharp-ls`, and whether the currently loaded Pi tool set contains the expected retrieval/LSP/code-mode capabilities.

For slow local models, reduce the tool schema exposed to the model:

```text
/offline-tools minimal
```

The profile prefers `code`, `knowledge_search`, and LSP tools when installed. If those are absent it retains Pi's built-in `grep/find/ls` fallbacks.

Restore the previous tool set with:

```text
/offline-tools restore
```


## Tool-result compaction

Large `dotnet build` and `dotnet test` shell outputs are compacted before they enter the model context.

The full output is preserved under:

```text
.pi/offline-engine/tool-results/
```

The model receives selected compiler/test diagnostics, a small tail when no diagnostics are found, and the artifact path.

Compaction is enabled by default only for large dotnet build/test results. Control it with:

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

This avoids spending early model turns on basic repository orientation. The snapshot is bounded, stored as data rather than instructions, and only the latest capsule is sent in model context.

It is enabled by default. Control it with:

```text
/offline-context on
/offline-context off
/offline-context refresh
/offline-context status
```

Set `PI_OFFLINE_REPO_CAPSULE=0` to disable it at startup.


## Recommended offline .NET companion stack

See [docs/OFFLINE_PROFILE.md](docs/OFFLINE_PROFILE.md).

Preview the pinned package installation plan without changing anything:

```bash
npm run profile:offline
```

After reviewing the package sources, apply it with:

```bash
node ./scripts/bootstrap-offline-profile.mjs --apply
```


## Canonical local gate

GitHub Actions runs the release gates on pushes and pull requests. Run the same checks locally, starting with:

```bash
npm ci
npm run gate:local
npm audit --omit=dev --audit-level=high
```

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

To run the delegated execute path against a real .NET fixture — real `dotnet build`/`dotnet test`, a scripted implementer that goes through the malformed-output retry and one red-test repair — run (needs a .NET 10 SDK and, once, network for NuGet; see [docs/LOCAL_VALIDATION.md](docs/LOCAL_VALIDATION.md)):

```bash
npm run gate:dotnet
```


## Training-data capture

Verified TinyCoder attempts can be captured locally for future SFT, preference training and evaluation.

Capture is **off by default**:

```text
/offline-training on
/offline-training status
/offline-training export
/offline-training off
```

See [docs/TRAINING_DATA.md](docs/TRAINING_DATA.md) before enabling it: raw traces may contain private source code.


## First real acceptance run

A controlled disposable .NET fixture is included so the first TinyCoder run tests the pipeline rather than an arbitrary repository.

Prepare it while online:

```bash
npm run acceptance:prepare -- --restore
```

Then follow [docs/ACCEPTANCE_V0.md](docs/ACCEPTANCE_V0.md).
