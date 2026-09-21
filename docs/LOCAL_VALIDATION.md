# Local validation

GitHub Actions is not a release gate for this project. The canonical v0 gate is local and network-independent.

## One command

From the repository root:

```bash
npm run gate:local
```

The gate executes:

1. syntax checks for every `.mjs`/`.ts` under `src/`, `scripts/`, `tests/` and `extensions/` (including the Pi extension);
2. all Node unit tests;
3. offline-profile bootstrap in dry-run mode;
4. a self-contained TinyCoder transport smoke test using a local in-process HTTP server.

No model download, npm install, NuGet restore, GitHub access, or external network call is part of this gate.

A successful run ends with:

```text
LOCAL GATE: PASS
```

Then verify the extension against the actually installed Pi runtime:

```bash
npm run gate:pi
```

This loads only `extensions/index.ts` through Pi's real extension loader in RPC mode, asks for the registered commands and requires `offline-setup`, `offline-doctor` and `offline-status` to be among them — no LLM request is made. An extension that throws while loading makes pi exit 1 and the gate fail with the thrown message. A successful run ends with `PI LOAD GATE: PASS`.

(The gate used to run `pi --list-models`, which exits 0 even when an extension fails to load, so it could not fail.)

## Turnkey install gate

```bash
npm run gate:install
```

This one needs network access and is not part of `gate:local`. It stages the working tree the way a clone would see it, runs the exact `npm install --omit=dev` pi runs for git packages (raw output goes to a log whose path is printed first; the step is deliberately not time-bounded), checks every manifest extension exists on disk, runs `pi install` into a throwaway `PI_CODING_AGENT_DIR` — your own `~/.pi` is never touched — and finally starts pi in RPC mode and runs `/offline-doctor`, requiring the tools of all four bundled companion extensions to be active. Pass `--keep` to keep the work directory, or `--package-dir <dir>` to reuse an already installed staging directory. A successful run ends with `INSTALL GATE: PASS`.

## What this gate establishes

It establishes that the checked-out source is internally consistent at the contract/runtime level:

- ImplementationSpec and candidate validation;
- guarded apply helpers;
- verification command construction;
- RepairPacket;
- offline doctor;
- tool profile selection;
- output compaction;
- repository capsule;
- telemetry aggregation;
- TinyCoder OpenAI-compatible transport shape.

It does **not** establish:

- compatibility with the locally installed Pi version (that is `gate:pi` and `gate:install`);
- correctness of a real Qwen GGUF;
- llama.cpp tool/JSON behavior;
- C# LSP availability;
- real `dotnet build/test` against the user's project;
- quality or success rate of TinyCoder implementations.

Those belong to the machine-level acceptance test.

## Machine acceptance

After both `gate:local` and `gate:pi` pass:

1. start the real TinyCoder llama.cpp endpoint;
2. start Pi with this extension and check the first-run line reports the endpoint you expect (or run `/offline-setup`);
3. add `/.pi/offline-engine/` to the target repository's `.git/info/exclude` (local-only), then run `/offline-doctor` and resolve any remaining warnings before disconnecting;
4. switch to `/offline-tools minimal`;
5. disconnect the network;
6. perform one bounded C# task through `execute_delegated_implementation`;
7. confirm build/tests are run with `--no-restore`;
8. inspect `/offline-stats`;
9. confirm no provider/CDN/package-manager access was required.

Only after this should the installation be called ready for travel.
