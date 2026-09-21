export function resolveEndpointUrl(endpoint, route) {
  if (!endpoint) throw new Error("endpoint is required");
  const base = endpoint.endsWith("/") ? endpoint : endpoint + "/";
  const relative = String(route ?? "").replace(/^\/+/, "");
  const url = new URL(relative, base);

  // Ollama and LM Studio document their base URL as `http://host:port/v1`, so a
  // configured endpoint frequently already carries the prefix the route repeats.
  // Collapse the overlap instead of producing `/v1/v1/chat/completions`, which
  // 404s and makes `/offline-doctor` report the backend as unreachable.
  const baseSegments = segmentsOf(new URL(base).pathname);
  const routeSegments = segmentsOf(relative);
  const overlap = trailingOverlap(baseSegments, routeSegments);
  if (overlap === 0) return url;

  return new URL(routeSegments.slice(overlap).join("/"), base);
}

function segmentsOf(pathname) {
  return String(pathname).split("/").filter(Boolean);
}

function trailingOverlap(baseSegments, routeSegments) {
  const max = Math.min(baseSegments.length, routeSegments.length);
  for (let size = max; size > 0; size -= 1) {
    const tail = baseSegments.slice(baseSegments.length - size);
    const head = routeSegments.slice(0, size);
    if (tail.every((segment, index) => segment === head[index])) return size;
  }
  return 0;
}
