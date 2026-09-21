# Code review resolution — 2026-09-21

This document records the disposition of findings in `CODE_REVIEW_2026-09-21.md`.
The original review is intentionally left unchanged.

## Summary

The review findings were treated as real unless explicitly qualified below.

| # | Status | Resolution |
|---|---|---|
| 1 | confirmed | fixed invalid test syntax; repository-wide syntax walker now checks tests too |
| 2 | confirmed | direct-only compaction contract chosen and tested |
| 3 | confirmed | compound/pipelined/substituted shell commands are never compacted |
| 4 | confirmed | `replace_text` content is inserted through a replacement callback, so `$` sequences remain literal |
| 5 | confirmed | acceptance output deletion requires a managed marker and refuses destructive roots/ancestors |
| 6 | confirmed | exporter redaction widened; raw/export paths inspect candidate paths too |
| 7 | confirmed with qualification | verification failures already retried; invalid candidate / malformed model output now get bounded cheap retries before mutation |
| 8 | confirmed | already-aborted caller signals abort TinyCoder immediately |
| 9 | confirmed | offline doctor fails closed when configured model cannot be verified from the catalog |
| 10 | confirmed | `npm run check` recursively checks `.mjs` and extension `.ts` under src/scripts/tests/extensions |
| 11 | confirmed | endpoint routes preserve configured path prefixes |
| 12 | confirmed | json-schema fallback requires a nearby structured-output incompatibility signal, not generic `unknown` text |
| 13 | confirmed as test-quality issue | critical orchestration policy has behavioral tests in pure modules; source-contract tests remain structural smoke, and real Pi loading is covered by `gate:pi` |

## Retry policy after the fix

Model-output failures are distinct from infrastructure failures:

- invalid candidate schema/path/operation: retry while no workspace mutation occurred and attempts remain;
- malformed/missing TinyCoder JSON output: same;
- HTTP errors, unknown model, timeout/transport failures: escalate immediately;
- apply or verification infrastructure failures: escalate immediately;
- ordinary red verification: use the existing RepairPacket loop.

This keeps retries cheap without retrying failures that are unlikely to improve from another sample.

## Safety notes

Training-data redaction remains best-effort, not a publication guarantee. Exported corpora still require human review.

The acceptance preparer treats its output as managed scratch space. It will only recursively replace an existing directory carrying its marker and will not accept filesystem root, home, repository/cwd roots, or their ancestors.

## Validation

The branch adds behavioral regressions for:

- direct-only tool-result compaction;
- literal replacement content containing `$'`, `$&`, and `$$`;
- destructive acceptance output rejection;
- realistic secret forms and candidate sensitive paths;
- pre-aborted TinyCoder requests;
- endpoint path prefixes;
- structured-output fallback boundaries;
- doctor model-catalog failure;
- model-output retry policy;
- repository syntax walker coverage.

Run locally:

```bash
npm run check
npm test
npm run gate:local
npm run gate:pi
```
