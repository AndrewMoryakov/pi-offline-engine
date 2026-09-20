# Training data capture v0

pi-offline-engine can optionally record verified TinyCoder attempts for future local model work.

## Principle

Capture the **bounded implementation transaction**, not a generic chat transcript:

```text
ImplementationSpec
+ bounded context
+ optional RepairPacket
        ↓
TinyCoder candidate
        ↓
compiler/tests
        ↓
verification label
```

This naturally produces supervised and preference data with deterministic evidence.

## Privacy and safety

Training capture is **off by default**.

Enable it explicitly in Pi:

```text
/offline-training on
```

or before startup:

```text
PI_OFFLINE_TRAINING_CAPTURE=1
```

Raw capture stores exact bounded context and generated candidate content under:

```text
.pi/offline-engine/training/raw.jsonl
```

Do not publish or upload this raw file without reviewing it. Source code can contain confidential information.

Capture is automatically skipped when the declared target/scope includes obvious secret-bearing paths such as:

- `.env*`
- credential/secret files
- private-key files

Recorder failures are best-effort and never change the coding pipeline result.

## What one raw record contains

Each TinyCoder attempt can include:

- run/spec/model/attempt identity;
- exact `ImplementationSpec`;
- bounded context sent to TinyCoder;
- RepairPacket for repair attempts;
- generated candidate;
- verification outcome;
- compiler/test diagnostics;
- runner/test-count evidence;
- token usage and latency.

Infrastructure failures are recorded separately and are not exported as implementation examples.

## Export

Inside the repository whose local traces you want to export:

```text
/offline-training export
```

or:

```bash
npm run training:export
```

Exports are written under:

```text
.pi/offline-engine/training/export/
```

### sft.jsonl

Success-only prompt/completion examples:

```json
{"prompt":"...","completion":"...","meta":{}}
```

Useful for training a small bounded implementation backend.

### unpaired-preference.jsonl

Every candidate attempt receives a deterministic boolean label:

```json
{"prompt":"...","completion":"...","label":true,"meta":{}}
```

This matches the general unpaired-preference pattern supported by modern post-training libraries such as TRL.

### paired-preference.jsonl

Generated **only** when the corpus contains both a verified and failed candidate for the exact same prompt.

```json
{"prompt":"...","chosen":"...","rejected":"...","meta":{}}
```

Repair attempts are not falsely paired with earlier attempts because their RepairPacket changes the prompt.

This can become useful for DPO-style training after we intentionally add same-prompt multi-sampling/shadow generation.

### eval.jsonl

Keeps prompt, completion and deterministic verification metadata for evaluation/benchmarking without implying that every completion should be imitated.

## Export hygiene

The exporter:

- drops obvious secret-bearing paths;
- applies best-effort secret redaction to strings;
- deduplicates exact prompt/completion examples;
- keeps source run/spec/model/outcome metadata;
- writes a manifest with counts and dropped-record statistics.

This is a safety filter, **not a guarantee that a dataset is safe to publish**. Review exported data before sharing outside the local machine.

## Likely future uses

The same corpus can later train or evaluate:

1. **Tiny Implementer** — spec/context → bounded patch.
2. **Repair model** — spec + failed candidate + diagnostics → corrected candidate.
3. **Delegation/router model** — predict whether a task is safe for 0.5B/1.5B/3B or needs the main model.
4. **Candidate verifier/ranker** — rank multiple same-prompt candidates before expensive build/test.
5. **Context selector** — learn which snippets/API facts are actually needed for successful implementation.

The first goal is collection quality, not dataset volume.
