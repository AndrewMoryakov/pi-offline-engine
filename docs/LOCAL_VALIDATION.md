# Local validation

GitHub Actions is not a release gate for this project. The canonical v0 gate is local and network-independent.

## One command

From the repository root:

```bash
npm run gate:local
```

The gate executes:

1. all Node unit tests;
2. syntax checks for runtime modules;
3. TypeScript syntax stripping/check for the Pi extension;
4. offline-profile bootstrap in dry-run mode;
5. a self-contained TinyCoder transport smoke test using a local in-process HTTP server.

No model download, npm install, NuGet restore, GitHub access, or external network call is part of this gate.

A successful run ends with:

```text
LOCAL GATE: PASS
```

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

- compatibility with the locally installed Pi version;
- correctness of a real Qwen GGUF;
- llama.cpp tool/JSON behavior;
- C# LSP availability;
- real `dotnet build/test` against the user's project;
- quality or success rate of TinyCoder implementations.

Those belong to the machine-level acceptance test.

## Machine acceptance

After the local gate passes:

1. start the real TinyCoder llama.cpp endpoint;
2. start Pi with this extension;
3. run `/offline-doctor` and resolve any MTP/TRX warning before disconnecting;
4. switch to `/offline-tools minimal`;
5. disconnect the network;
6. perform one bounded C# task through `execute_delegated_implementation`;
7. confirm build/tests are run with `--no-restore`;
8. inspect `/offline-stats`;
9. confirm no provider/CDN/package-manager access was required.

Only after this should the installation be called ready for travel.
