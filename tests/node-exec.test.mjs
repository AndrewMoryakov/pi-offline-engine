import assert from "node:assert/strict";
import test from "node:test";
import { nodeExec } from "../src/node-exec.mjs";

// The child writes the two bytes of "Ж" (0xD0 0x96) in separate chunks with a
// pause between them, so the pipe delivers them as two `data` events.
const SPLIT_UTF8 = "process.stdout.write(Buffer.from([0xd0])); setTimeout(() => process.stdout.write(Buffer.from([0x96])), 80);";

test("multi-byte characters split across chunks are decoded whole", async () => {
  const result = await nodeExec(process.execPath, ["-e", SPLIT_UTF8], { timeout: 10_000 });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "Ж");
});

test("stderr is decoded the same way", async () => {
  const script = SPLIT_UTF8.replaceAll("stdout", "stderr");
  const result = await nodeExec(process.execPath, ["-e", script], { timeout: 10_000 });
  assert.equal(result.stderr, "Ж");
});
