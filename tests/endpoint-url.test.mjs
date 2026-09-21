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

test("collapses a version prefix the configured endpoint already carries", () => {
  assert.equal(
    resolveEndpointUrl("http://127.0.0.1:11434/v1", "v1/chat/completions").href,
    "http://127.0.0.1:11434/v1/chat/completions"
  );
  assert.equal(
    resolveEndpointUrl("http://127.0.0.1:11434/v1/", "v1/models").href,
    "http://127.0.0.1:11434/v1/models"
  );
  assert.equal(
    resolveEndpointUrl("http://127.0.0.1:1234/openai/v1", "v1/models").href,
    "http://127.0.0.1:1234/openai/v1/models"
  );
});

test("still appends routes that do not overlap the endpoint path", () => {
  assert.equal(
    resolveEndpointUrl("http://127.0.0.1:11434", "v1/chat/completions").href,
    "http://127.0.0.1:11434/v1/chat/completions"
  );
  assert.equal(
    resolveEndpointUrl("http://127.0.0.1:11434/v1", "health").href,
    "http://127.0.0.1:11434/v1/health"
  );
});
