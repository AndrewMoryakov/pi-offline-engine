# pi-offline-engine

Offline-first extension experiments for the Pi coding agent.

The project explores a compound local coding system where a large local model is reserved for reasoning and architecture, while deterministic tools and a much smaller local coding model perform bounded implementation work.

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
