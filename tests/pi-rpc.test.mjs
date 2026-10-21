import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { runPiSync } from "../scripts/lib/pi-rpc.mjs";

test("integration gates run the locked Pi even without a pi executable on PATH", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"));
  env.PATH = "";
  const result = runPiSync(["--version"], { env, timeout: 30_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), manifest.devDependencies["@earendil-works/pi-coding-agent"]);
});
