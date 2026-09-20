# Bounded Delegation v0

## Purpose

Prove a useful contract between a slow main reasoning model and a fast local coding model while keeping mutation and verification under Pi control.

## Two surfaces

### `delegate_implementation`

Candidate-only mode. The main agent creates `ImplementationSpec v1`; the TinyCoder returns a bounded candidate. No files are modified.

### `execute_delegated_implementation`

Bounded execution mode:

```text
ImplementationSpec
  -> user approves declared scope once
  -> capture SHA-256 preimage
  -> TinyCoder candidate
  -> validate paths/operations
  -> exact deterministic apply
  -> dotnet build/tests --no-restore
  -> if red: compact RepairPacket
  -> TinyCoder repair
  -> at most 3 total attempts
  -> return verification_passed evidence or escalate to main model
```

The main 27B model is intentionally absent from the inner repair loop. A `verification_passed` result means only that the declared compiler/test checks passed; it does not mean the user task is semantically complete. The main agent must inspect the current diff/changed files before claiming completion. In v0, `execute_delegated_implementation` must be the only mutating tool in its assistant turn so sibling writes cannot contaminate verification.

## Candidate operations

v1 auto-apply supports only:

- `replace_text` with exact `expected` text that occurs exactly once;
- `create_file` when the spec explicitly permits new files and the path is present in `scope.allowed_files`.

Symbolic links and paths outside the workspace/scope are rejected.

More semantic operations such as `replace_symbol` belong to a later Tree-sitter/Roslyn-backed slice.

## Preimage rule

Pi snapshots SHA-256 for every allowed file **before** each TinyCoder call.

Application is refused if an allowed file appears, disappears, or changes while the TinyCoder is working. This prevents a stale candidate from overwriting concurrent user/agent edits.

Pi also participates in Pi's `withFileMutationQueue()` for every affected path, so built-in edit/write calls cannot race the delegated mutation in the same process.

## Verification contract

v1 accepts:

```json
{
  "verification": {
    "build": { "project": "src/App/App.csproj" },
    "tests": {
      "project": "tests/App.Tests/App.Tests.csproj",
      "names": ["RetryTests.Cancellation"]
    }
  }
}
```

Pi constructs the commands itself. The model cannot inject an arbitrary verification shell command.

Checks run with `--no-restore` for offline safety. Test verification requires a fresh TRX result proving `executed > 0`; exit code 0 alone is never sufficient evidence. In VSTest mode each declared test pattern runs independently through `--filter`. In .NET 10 Microsoft.Testing.Platform mode the project suite runs once with `--report-trx`, and every declared pattern must be found among executed TRX identities. MTP therefore requires the project to have `Microsoft.Testing.Extensions.TrxReport` available before going offline. Full stdout/stderr is stored under `.pi/offline-engine/artifacts/`; only compact diagnostics are sent back through model context.

## Repair

A red verification produces a compact `RepairPacket` containing:

- previous change paths/operations;
- build/test status;
- selected diagnostics;
- artifact references.

The next TinyCoder call sees the original specification plus the RepairPacket and the caller-supplied bounded context.

Default: three total TinyCoder attempts (initial + two repairs). `PI_OFFLINE_TINY_MAX_ATTEMPTS` may lower this but is capped at 3.

## Headless safety

Mutating delegated execution requires interactive confirmation by default.

Headless mutation is rejected unless `PI_OFFLINE_ALLOW_HEADLESS_APPLY=1` is explicitly set. That mode is intended only inside a separately controlled sandbox.

## Runtime files

All generated state is local and gitignored:

- `.pi/offline-engine/events.jsonl`
- `.pi/offline-engine/candidates/`
- `.pi/offline-engine/artifacts/`

Candidate records include generated patch content for local inspection. The event log contains control metadata rather than full source payloads.

## Known boundary

If verification remains red after the final TinyCoder attempt, the last bounded candidate remains in the workspace and control returns to the main model. v0 does not attempt autonomous git rollback or crash-safe transactional recovery; those are separate reliability features rather than hidden behavior.
