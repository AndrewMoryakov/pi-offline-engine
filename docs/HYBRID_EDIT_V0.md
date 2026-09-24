# Hybrid edit v0

Statement of the task behind `editProvider: "hybrid"`. Code comments cite the
items below as `HYBRID_EDIT_V0 HE-n`.

Each item says where it came from:

- **requested**: asked for by the owner;
- **constraint**: a fact about Pi or another package, with the evidence;
- **decision**: an engineering choice made while implementing, open to reversal.

## Background

On 2026-09-24 pi stopped at startup on TashkentServ:

```text
Error: Failed to load extension ".../pi-offline-engine/node_modules/pi-lean-edit/index.ts":
Tool "edit" conflicts with .../sting8k/pi-utils/extensions/edit.ts
```

PR #8 added `editProvider: "none"`, which lets the user pick one provider. It
does not let both run.

## Items

**HE-1 (constraint).** Pi refuses to start when two extensions register one
tool name. Evidence: the conflict check over every extension's tools in
Pi's `dist/core/resource-loader.js` (`Tool "${toolName}" conflicts with ...`).
Extensions cannot see other packages' tools while they load, so the clash
cannot be detected and avoided at load time.

**HE-2 (requested).** Keep both edit tools in one pi and let the right one be
used for the situation: pi-lean-edit's range edit for targeted changes, the
pi-utils script edit for one mechanical change repeated across many files.

**HE-3 (decision).** Hybrid is opt-in: `editProvider: "hybrid"` in the engine
config or `PI_OFFLINE_EDIT_PROVIDER=hybrid`. The default stays `"lean"`, so
existing installs behave as after PR #8.

**HE-4 (constraint, then decision).** `sting8k/pi-utils` is not ours to
change (GitHub `viewerPermission: READ`) and registers the literal name
`edit`. So pi-lean-edit's edit is the one renamed: it registers as
`line_edit`, through a proxied `ExtensionAPI` in `extensions/pi-lean-edit.ts`;
pi-lean-edit's own source is not patched. Its prompt guidelines address the
tool as `edit:` and are rewritten with the name, plus one line on when to
use which tool.

**HE-5 (decision).** Which tools the model sees is decided in code, without a
cloud classifier (Jev-based routers were considered): the engine's premise is
that source stays on the operator's network (`/offline-doctor`'s
`endpoint_locality`). The signal is the session model's `baseUrl`, judged by
the same `isLocalHost` the doctor uses, on `session_start` and `model_select`.
A local model gets `line_edit` only; a remote one gets both.

**HE-6 (decision).** `scriptEditPolicy` / `PI_OFFLINE_SCRIPT_EDIT_POLICY`:
`cloud-only` (default, HE-5), `always`, `never`. `always` exists because a
strong model reached through a local address (a tunnel or relay on
`127.0.0.1`) counts as local by `baseUrl`.

**HE-7 (decision).** The policy never rebuilds the tool set. It removes and
restores only `edit`, and restores it only if it removed it, so
`/offline-tools minimal` and a user's own choice are left alone. `minimal`
keeps a hidden `edit` hidden.

**HE-8 (decision).** `/offline-doctor` names the source of both tools in
hybrid mode and whether `edit` is offered, and why, because a hidden `edit`
otherwise looks like a missing one.

**HE-9 (decision).** `gate:pi` loads the engine alone and cannot see a clash
with another package. `gate:edit` (also in CI) loads
`extensions/pi-lean-edit.ts` next to a fixture that registers `edit`, in a
throwaway agent dir, for each mode. `lean` must still be refused, which shows
the gate can fail.

## Out of scope

- `pi-code-tool`'s bridge calls Pi's built-ins directly and bypasses both
  tools (see `OFFLINE_PROFILE.md`).
- pi-lean-edit's metrics key on the tool name `edit` (`src/metrics.ts:82` in
  pi-lean-edit 0.3.6); not checked for the renamed tool.
- A model editing through `line_edit` in a live session has not been
  observed.
