# Offline .NET Profile v1

This profile is the recommended companion stack for `pi-offline-engine` when the main model is local and relatively slow.

The objective is not to maximize the number of Pi tools. It is to move routine repository work out of the large model while keeping the model-facing tool surface small.

## Recommended stack

### Bundled — installed automatically

These four are exact-pinned `dependencies` of `pi-offline-engine` and are loaded through its pi manifest. `pi install git:github.com/AndrewMoryakov/pi-offline-engine` brings them in; there is no second step. **Do not `pi install` them separately** — that registers a duplicate copy of the same tools.

- **pi-knowledge 0.10.2** — local-first BM25 + embeddings retrieval. Uses local `multilingual-e5-small` by default; the engine sets the `low_token` search profile unless you chose another.
- **pi-lsp-extension 1.3.0** — live language semantics, diagnostics, definition/references, plus structural Tree-sitter fallback and code search/rewrite. It asks for `vscode-languageserver-protocol@^3.17.5` but imports the file path `vscode-languageserver-protocol/node.js`; 3.18.0 added an `exports` map that publishes only `./node`, so a fresh install resolves 3.18.x and the extension fails to load with `Package subpath './node.js' is not defined by "exports"`. 1.3.0 is the latest release, so `package.json` pins the transitive dependency back to 3.17.5 through `overrides` — the last version without that map, and one that still ships a root `node.js`. Remove the override once upstream publishes a build that imports `./node`.
- **pi-code-tool 0.6.1** — sandboxed Python composition over host tools so loops/filtering/aggregation do not require a model turn per primitive. Its interpreter (`@pydantic/monty`) ships prebuilt per-platform binaries; no system Python is needed. In this profile it is treated as a **read-only orchestration tool**: do not use its bridged bash/edit/write calls, because the bridge constructs Pi built-ins directly and does not pass through top-level edit overrides such as pi-lean-edit. The engine adds this rule to the system prompt whenever the `code` tool is active.
- **pi-lean-edit 0.3.6** — replaces `read/edit/write` with snapshot-backed range edits so the model does not have to reproduce old text in every edit. Loaded through `extensions/pi-lean-edit.ts`, which skips it when the engine config sets `editProvider: "none"` — the way out when another package (pi-utils) also overrides `edit`. With `editProvider: "hybrid"` it loads with its edit renamed to `line_edit`, beside the other `edit`; see the README, "Another package that overrides `edit`".

The bundled set and the pins are checked against each other by `tests/packaging.test.mjs`.

### Optional

- **pi-sub-agent 0.1.5** — use only for explicit, statically assigned `scout` or `reviewer` work. Do not make every task multi-agent and do not run CPU-heavy agents in parallel by default.

### Deferred

- **pi-tree-sitter 0.2.8** — its pre-write syntax guard is attractive, but it is edit-aware and `pi-lean-edit` also replaces the edit surface with a different schema. The current default profile does not load both until that combination is qualified end-to-end.

This does **not** mean Tree-sitter is absent: `pi-lsp-extension` already includes Tree-sitter fallback for structural operations. The deferred package would add an independent pre-write guard and another structural tool surface.

## Bootstrap

The bootstrap script now only handles the non-bundled tiers. Dry run:

```bash
node ./scripts/bootstrap-offline-profile.mjs
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

Nothing is required. The engine's own settings (`PI_OFFLINE_COMPACT_TOOL_RESULTS`, `PI_OFFLINE_REPO_CAPSULE`, `PI_OFFLINE_TINY_MAX_ATTEMPTS`) already default to the profile values, and the TinyCoder endpoint/model is discovered on first run (see the README). Environment variables still override anything saved:

```bash
PI_OFFLINE_TINY_ENDPOINT=http://127.0.0.1:8080
PI_OFFLINE_TINY_MODEL=<model id>
```

For fully offline work, add this **only after** pi-knowledge has downloaded its local embedding model — index one real repository while online first. Set earlier, it blocks that download:

```bash
PI_KNOWLEDGE_OFFLINE=1
```

## C# language server

`csharp-ls` currently requires the .NET 10 SDK or newer to run. It may still analyze projects targeting older .NET versions.

After installation, configure the LSP extension for C# if it does not auto-detect the server:

```text
/lsp-config csharp csharp-ls stdio
```

Do not change a repository's target framework or `global.json` just to make the language server run.

## .NET 10 test runner note

If the repository opts into Microsoft.Testing.Platform through `global.json` (`test.runner = Microsoft.Testing.Platform`), pi-offline-engine uses MTP's `--report-trx` evidence path instead of VSTest's `--logger trx`. The test project must already reference or otherwise provide `Microsoft.Testing.Extensions.TrxReport`; restore it while online. `/offline-doctor` warns when MTP is detected but the TRX option is not advertised.

## Before going offline

While the network is still available:

1. install pi-offline-engine (bundled packages come with it) and any optional packages you selected;
2. add `/.pi/offline-engine/` to the target repository's `.git/info/exclude` so local engine artifacts cannot be accidentally staged;
3. force the local embedding model to download by indexing a real repository with `pi-knowledge`;
4. run `knowledge_doctor` and confirm the index is ready;
5. start C# LSP at least once on the real solution;
6. make sure the main GGUF and TinyCoder GGUF are local and the TinyCoder server is running;
7. run `dotnet restore` on the project(s) you expect to work on;
8. set `PI_KNOWLEDGE_OFFLINE=1`, disconnect networking and run `/offline-doctor`;
9. run one real small edit/build/test task offline.

For the slow main local model, then use:

```text
/offline-tools minimal
```

This keeps high-level code/knowledge/LSP tools when present and hides redundant low-level schemas.
