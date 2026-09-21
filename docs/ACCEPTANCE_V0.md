# Local acceptance v0

This document defines the first real machine-level acceptance test for pi-offline-engine.

## Goal

Prove the runtime path, not model cleverness:

```text
main local model
  -> ImplementationSpec
  -> TinyCoder
  -> guarded apply
  -> build
  -> declared tests
  -> optional repair
  -> verification_passed or explicit escalation
```

## 1. Prepare while online

From the pi-offline-engine repository:

```bash
npm run gate:local
npm run gate:pi
node ./scripts/prepare-acceptance-v0.mjs --restore
```

The fixture is created in the OS temp directory by default and initialized as its own Git repository.

The test project uses **MSTest.Sdk 4.4.1**. Restore it before disconnecting from the network.

## 2. Confirm the baseline

Change into the printed fixture directory and run:

```bash
dotnet build src/Acceptance.Core/Acceptance.Core.csproj --no-restore
dotnet test tests/Acceptance.Tests/Acceptance.Tests.csproj --no-restore
```

Expected:

- build passes;
- one boundary test fails;
- three preserve tests pass.

If this baseline is not observed, do not run the agent yet.

## 3. Start the real TinyCoder

Start the chosen llama.cpp server and set:

```text
PI_OFFLINE_TINY_ENDPOINT=<local endpoint>
PI_OFFLINE_TINY_MODEL=<exact model id exposed by the endpoint>
PI_OFFLINE_TINY_MAX_ATTEMPTS=3
```

## 4. Start Pi in the fixture

Load pi-offline-engine, then run:

```text
/offline-doctor
/offline-tools minimal
/offline-status
```

Resolve required failures before proceeding.

## 5. Disconnect networking

Disable network access and run `/offline-doctor` again.

## 6. Run the task

Give the main model the task from `ACCEPTANCE_TASK.md`.

Do not manually edit the fixture during the delegated call.

## 7. Collect evidence

After the task:

```text
/offline-stats
```

And from the shell:

```bash
git status --short
git diff
dotnet test tests/Acceptance.Tests/Acceptance.Tests.csproj --no-restore
```

Record:

- end-to-end wall time;
- main-model calls/tokens if available;
- TinyCoder calls/input/output tokens;
- TinyCoder average latency;
- repair attempts;
- escalation yes/no;
- final changed files;
- final build/test result;
- whether any network access was required.

## 8. Acceptance decision

The fixture run is successful when:

- no write escapes the declared file scope;
- all four tests execute and pass;
- tool returns `verification_passed`, not semantic `task_complete`;
- main model inspects/accepts the result;
- no hidden network dependency appears;
- telemetry is available.

Only after this run should the engine be tried on a copied real repository.
