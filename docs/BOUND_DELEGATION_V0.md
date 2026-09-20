# Bounded Delegation v0

## Purpose

Prove the smallest useful contract between a slow main reasoning model and a fast local coding model before adding automatic writes or repair loops.

## Boundary

The main Pi agent owns problem understanding and produces an `ImplementationSpec v1`.

The tiny implementer receives only that bounded spec plus explicitly supplied context. It may return:

- `candidate`
- `insufficient_spec`
- `cannot_safely_implement`

A candidate is rejected if it names an unsupported operation, an unsafe path, or a path outside the spec scope.

v0 never writes the candidate to disk.

## Runtime

`delegate_implementation` calls an OpenAI-compatible endpoint:

- `PI_OFFLINE_TINY_ENDPOINT` (default `http://127.0.0.1:8081`)
- `PI_OFFLINE_TINY_MODEL` (default `qwen2.5-coder-3b-instruct`)

The intended first backend is llama.cpp serving Qwen2.5-Coder-3B-Instruct.

## Telemetry

Events are appended to `.pi/offline-engine/events.jsonl`.

Only control metadata is logged in v0: spec id, model, endpoint, latency, usage, candidate status and validation outcome. Full source/context payloads are not copied into the event log.

## Next gate

Do not add autonomous repair until deterministic candidate application has:

1. preimage/stale-state protection;
2. allowed-file enforcement at apply time;
3. a reversible or inspectable patch representation;
4. unit tests for partial failure.

After that, add syntax/LSP/build/test verification and a compact `RepairPacket`.
