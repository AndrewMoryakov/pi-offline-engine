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

```bash
pi install git:github.com/AndrewMoryakov/pi-offline-engine
```

During development from a clone:

```bash
pi -e ./extensions/index.ts
```

Pi extensions execute with user permissions. Review source before installation.

## Tiny implementer

Run an OpenAI-compatible local endpoint, for example llama.cpp serving Qwen2.5-Coder-3B-Instruct:

```bash
export PI_OFFLINE_TINY_ENDPOINT=http://127.0.0.1:8081
export PI_OFFLINE_TINY_MODEL=qwen2.5-coder-3b-instruct
export PI_OFFLINE_TINY_MAX_ATTEMPTS=3
```

Then run Pi normally. If the endpoint includes a reverse-proxy path prefix, that prefix is preserved when resolving `health`, `v1/models`, and `v1/chat/completions`.

`/offline-status` shows the active local settings.

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

GitHub Actions is informational only for this project. The canonical release-candidate check is:

```bash
npm run gate:local
```

It is designed to run without external network access. Then run:

```bash
npm run gate:pi
```

to load the extension through the actually installed Pi runtime without making an LLM request. See [docs/LOCAL_VALIDATION.md](docs/LOCAL_VALIDATION.md).


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
