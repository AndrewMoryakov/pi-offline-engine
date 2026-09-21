# dotnet-boundary-v0

A deliberately tiny .NET fixture for the first real `pi-offline-engine` run.

The fixture contains one localized bug in `LoyaltyDiscount.Apply`. Its purpose is to exercise the complete delegation pipeline, not to benchmark coding intelligence.

Use `scripts/prepare-acceptance-v0.mjs` rather than editing this template in place. The script copies it into an isolated nested Git repository so the acceptance run cannot modify the pi-offline-engine source tree.
