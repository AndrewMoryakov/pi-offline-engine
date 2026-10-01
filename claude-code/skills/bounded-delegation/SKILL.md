---
name: bounded-delegation
description: Use when a code change in a .NET repository is already fully decided (which symbol, what behaviour, which one or two files, which build/test proves it) and could be handed to the pi-offline-engine implementer instead of being typed out by you. Covers writing the ImplementationSpec, what context to pass, and how to read the result. Not for exploration, design, or changes spanning more than two files.
---

# Bounded delegation to the pi-offline-engine implementer

The `pi-offline-engine` MCP server hands a precise change to a cheaper
implementer model (a local llama.cpp / LM Studio / Ollama server, or a hosted
OpenAI-compatible router), applies its answer only inside the files you
declared, runs the declared `dotnet` build/tests with `--no-restore`, and lets
the implementer repair its own compiler/test failures up to two times. You stay
the reasoner. The implementer never explores the repository.

## When it is worth it

Delegate when all of these hold:

- you already know the exact symbol and the required behaviour;
- the change touches at most two files (`scope.allowed_files`, 1–2 entries);
- a `dotnet build` target and, ideally, named tests prove it;
- the edit is mechanical enough that describing it is shorter than writing it.

Do the work yourself for design decisions, ambiguous requirements, broad
refactors, or anything needing repository exploration.

## Tools

- `delegate_implementation` returns a candidate and writes nothing. Use it to
  preview.
- `execute_delegated_implementation` applies, verifies and repairs. Make it the
  **only mutating call in its turn**: no parallel Edit/Write/Bash changes, or
  they could land in the middle of verification.
- `offline_doctor` checks the implementer endpoint and model, `dotnet`, and
  whether `.pi/` is ignored. Run it first in a new environment.
- `offline_status` shows the effective settings, `offline_stats` the call
  counts and tokens.

## ImplementationSpec v1

```json
{
  "version": 1,
  "spec_id": "retry-cancellation-001",
  "operation": "modify_symbol",
  "goal": { "summary": "Propagate cancellation into the retry delay." },
  "target": { "file": "src/Payments/RetryPolicy.cs", "symbol": "RetryPolicy.ExecuteAsync" },
  "requirements": [
    "Call ThrowIfCancellationRequested before every retry.",
    "Pass cancellationToken to Task.Delay."
  ],
  "preserve": ["Public signature of ExecuteAsync"],
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

Paths are relative to the workspace root. The engine builds the verification
commands itself; it never runs a command taken from the spec.

## Context

The implementer answers with exact `replace_text` edits, so its `expected` text
must match the file byte for byte. Pass the current source of the target symbol
(and anything it must call) in `context`, copied from what you just read, e.g.
`{"relevant_source": {"src/Payments/RetryPolicy.cs": "<exact excerpt>"}}`.
A stale or paraphrased excerpt makes the edit miss, and you pay for a retry.

## Reading the result

- `verification_passed` means only that the declared build/tests passed
  (`task_complete` is always `false`). Read the diff before you tell the user
  the task is done.
- `needs_main_model` returns control to you. `workspace_modified` and
  `changed_files` say whether a partial candidate is on disk. It is not rolled
  back, so fix it yourself or revert those files.
- `insufficient_spec` / `cannot_safely_implement` means the implementer declined.
  Tighten the spec or context, or do the change yourself.

## Privacy

If `offline_doctor` reports an `endpoint_locality` warning, the implementer is a
hosted service: the spec and the source you pass in `context` leave the machine.
