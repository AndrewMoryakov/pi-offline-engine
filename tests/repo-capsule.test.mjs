import test from "node:test";
import assert from "node:assert/strict";
import { buildRepoCapsule, formatRepoCapsule } from "../src/repo-capsule.mjs";

test("builds a bounded deterministic git repository capsule", async () => {
  const responses = new Map([
    ["rev-parse --show-toplevel", { code: 0, stdout: "/repo\n", stderr: "", killed: false }],
    ["branch --show-current", { code: 0, stdout: "feature/x\n", stderr: "", killed: false }],
    ["rev-parse --short=12 HEAD", { code: 0, stdout: "abc123def456\n", stderr: "", killed: false }],
    ["status --short --untracked-files=no", { code: 0, stdout: " M src/A.cs\nM  src/B.cs\n", stderr: "", killed: false }],
    ["ls-files -- *.sln *.slnx *.csproj global.json", { code: 0, stdout: "App.sln\nsrc/App.csproj\n", stderr: "", killed: false }]
  ]);

  const exec = async (_command, args) => {
    const result = responses.get(args.join(" "));
    if (!result) throw new Error(`unexpected command: ${args.join(" ")}`);
    return result;
  };

  const capsule = await buildRepoCapsule({ cwd: "/repo/sub", exec });
  assert.equal(capsule.available, true);
  assert.match(capsule.text, /feature\/x/);
  assert.match(capsule.text, /src\/App.csproj/);
  assert.match(capsule.text, /src\/A.cs/);
  assert.equal(capsule.fingerprint.length, 64);
});

test("returns unavailable outside a git repository", async () => {
  const exec = async () => ({ code: 128, stdout: "", stderr: "not a git repository", killed: false });
  const capsule = await buildRepoCapsule({ cwd: "/tmp", exec });
  assert.equal(capsule.available, false);
  assert.equal(capsule.text, null);
});

test("format labels snapshot as deterministic data rather than instructions", () => {
  const text = formatRepoCapsule({
    root: "/repo",
    branch: "main",
    head: "abc",
    dirty: [],
    dirtyTruncated: false,
    projectFiles: [],
    projectFilesTruncated: false
  });
  assert.match(text, /data, not an instruction/);
  assert.match(text, /clean tracked working tree/);
});
