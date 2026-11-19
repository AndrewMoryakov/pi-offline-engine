# Local validation

GitHub Actions runs the locked install, local contract gate, production dependency audit, pinned-Pi load gate, and isolated package install gate. The first gate remains network-independent and can be run locally at any time.

## One command

From the repository root:

```bash
npm ci
npm run gate:local
npm audit --omit=dev --audit-level=high
```

`npm ci` reproduces the reviewed lockfile, including Pi 1.3.0 used by the
integration gate and the security override for `sharp@0.35.5`. The audit is a
release check and requires npm registry access; `gate:local` itself remains
fully offline.

The gate executes:

1. syntax checks for every `.mjs`/`.ts` under `src/`, `scripts/`, `tests/`, `extensions/`, `claude-code/` and `mcp/`;
2. all Node tests, including the real Pi SDK loadout/nested-call contract;
3. offline-profile bootstrap in dry-run mode;
4. a self-contained TinyCoder transport smoke test using a local in-process HTTP server;
5. the real Pi RPC extension-load gate described below.

No model download, npm install, NuGet restore, GitHub access, or external network call is part of this gate.

A successful run ends with:

```text
LOCAL GATE: PASS
```

The extension-load step can also run separately. It resolves the
repository-pinned Pi 1.3.0 through its package manifest and starts its CLI with
the current Node executable, including when invoked directly from another cwd.
It does not use a global Pi from `PATH`:

```bash
npm run gate:pi
```

This loads only `extensions/index.ts` through Pi's real extension loader in RPC mode and requires all eight `/offline-*` commands — no LLM request is made. An extension that throws while loading makes pi exit 1 and the gate fail with the thrown message. A successful run ends with `PI LOAD GATE: PASS`.

`tests/pi-host-contract.test.mjs` separately creates a real, isolated Pi SDK
session and checks that delegated execution stays declared to the model,
retains sequential execution, and cannot be called through `ctx.executeTool()`.
Candidate-only delegation remains callable. The nested-call test failed before
the `model-only` adaptation. `tests/pi-rpc.test.mjs` runs the CLI with no Pi on
`PATH`; it failed before the repository-local CLI resolution.

(The gate used to run `pi --list-models`, which exits 0 even when an extension fails to load, so it could not fail.)

## Turnkey install gate

```bash
npm run gate:install
```

This one needs network access and is not part of `gate:local`. It stages the working tree the way a clone would see it, runs the exact `npm install --omit=dev` pi runs for git packages (raw output goes to a log whose path is printed first; the step is deliberately not time-bounded), checks every manifest extension exists on disk, runs `pi install` into a throwaway `PI_CODING_AGENT_DIR` — your own `~/.pi` is never touched — and finally starts pi in RPC mode and runs `/offline-doctor`, requiring the tools of all four bundled companion extensions to be active. Pass `--keep` to keep the work directory, or `--package-dir <dir>` to reuse an already installed staging directory. A successful run ends with `INSTALL GATE: PASS`.

CI also runs the install gate against the already locked tree:

```bash
npm run gate:install -- --package-dir .
```

This form avoids a second install while retaining the isolated Pi agent-dir
and RPC checks.

## Real .NET verification gate

```bash
npm run gate:dotnet
```

This gate needs a .NET 10 SDK, and the fixture's MSTest.Sdk packages in the NuGet cache (the first run restores them online). It prepares the acceptance fixture in a temporary directory. It then calls `execute_delegated_implementation` from the real extension, with real `dotnet build` / `dotnet test` (TRX) and a scripted implementer that uses all three attempts:

1. malformed output, which takes the model-output retry;
2. a wrong candidate, which turns the tests red and produces a RepairPacket;
3. the fix.

It requires `verification_passed` on attempt 3, with only the declared file changed. A run ends with `DOTNET GATE: PASS`, or with `SKIPPED` when no `dotnet` is on PATH. The unit tests fake both `exec` and the Pi host, so this is the only gate that exercises real verification. It found a 10 s runner-detection timeout that failed every preflight on a Windows 11 workstation. Timing problems like that one show up only on machines slow enough to hit them.

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

- compatibility with a different global Pi version (the gates use the locked host);
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
