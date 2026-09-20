# Offline .NET Profile v1

This profile is the recommended companion stack for `pi-offline-engine` when the main model is local and relatively slow.

The objective is not to maximize the number of Pi tools. It is to move routine repository work out of the large model while keeping the model-facing tool surface small.

## Recommended stack

### Required

- **pi-knowledge 0.10.2** — local-first BM25 + embeddings retrieval. Use local `multilingual-e5-small`, `low_token`, and offline mode.
- **pi-lsp-extension 1.3.0** — live language semantics, diagnostics, definition/references, plus structural Tree-sitter fallback and code search/rewrite.
- **pi-code-tool 0.6.1** — sandboxed Python composition over host tools so loops/filtering/aggregation do not require a model turn per primitive.
- **pi-lean-edit 0.3.6** — replaces `read/edit` with snapshot-backed range edits so the model does not have to reproduce old text in every edit.

### Optional

- **pi-sub-agent 0.1.5** — use only for explicit, statically assigned `scout` or `reviewer` work. Do not make every task multi-agent and do not run CPU-heavy agents in parallel by default.

### Deferred

- **pi-tree-sitter 0.2.8** — its pre-write syntax guard is attractive, but it is edit-aware and `pi-lean-edit` also replaces the edit surface with a different schema. The current default profile does not load both until that combination is qualified end-to-end.

This does **not** mean Tree-sitter is absent: `pi-lsp-extension` already includes Tree-sitter fallback for structural operations. The deferred package would add an independent pre-write guard and another structural tool surface.

## Bootstrap

Dry run:

```bash
node ./scripts/bootstrap-offline-profile.mjs
```

Install reviewed required packages:

```bash
node ./scripts/bootstrap-offline-profile.mjs --apply
```

Add the simple subagent extension:

```bash
node ./scripts/bootstrap-offline-profile.mjs --apply --include-optional
```

Install `csharp-ls` too, but only when a .NET 10+ SDK is present:

```bash
node ./scripts/bootstrap-offline-profile.mjs --apply --install-csharp-ls
```

The script intentionally does not install the deferred standalone Tree-sitter extension unless `--include-deferred` is explicitly passed.

## Environment

Recommended:

```bash
PI_KNOWLEDGE_EMBEDDING=local:multilingual-e5-small
PI_KNOWLEDGE_SEARCH_PROFILE=low_token
PI_KNOWLEDGE_OFFLINE=1
PI_OFFLINE_COMPACT_TOOL_RESULTS=1
PI_OFFLINE_REPO_CAPSULE=1
PI_OFFLINE_TINY_MAX_ATTEMPTS=3
```

Also set the machine-specific TinyCoder endpoint/model:

```bash
PI_OFFLINE_TINY_ENDPOINT=http://127.0.0.1:8081
PI_OFFLINE_TINY_MODEL=<actual llama.cpp model id>
```

## C# language server

`csharp-ls` currently requires the .NET 10 SDK or newer to run. It may still analyze projects targeting older .NET versions.

After installation, configure the LSP extension for C# if it does not auto-detect the server:

```text
/lsp-config csharp csharp-ls stdio
```

Do not change a repository's target framework or `global.json` just to make the language server run.

## Before going offline

While the network is still available:

1. install all selected Pi packages;
2. force the local embedding model to download by indexing a real repository with `pi-knowledge`;
3. run `knowledge_doctor` and confirm the index is ready;
4. start C# LSP at least once on the real solution;
5. make sure the main GGUF and TinyCoder GGUF are local;
6. run `dotnet restore` on the project(s) you expect to work on;
7. disconnect networking and run `/offline-doctor`;
8. run one real small edit/build/test task offline.

For the slow main local model, then use:

```text
/offline-tools minimal
```

This keeps high-level code/knowledge/LSP tools when present and hides redundant low-level schemas.
