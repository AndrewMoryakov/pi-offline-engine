import test from "node:test";
import assert from "node:assert/strict";
import { resolveEndpointUrl } from "../src/endpoint-url.mjs";

test("preserves configured endpoint path prefix", () => {
  assert.equal(
    resolveEndpointUrl("http://127.0.0.1:1234/proxy", "v1/chat/completions").href,
    "http://127.0.0.1:1234/proxy/v1/chat/completions"
  );
  assert.equal(
    resolveEndpointUrl("http://127.0.0.1:1234/proxy/", "/health").href,
    "http://127.0.0.1:1234/proxy/health"
  );
});
