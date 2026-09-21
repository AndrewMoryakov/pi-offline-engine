export function resolveEndpointUrl(endpoint, route) {
  if (!endpoint) throw new Error("endpoint is required");
  const base = endpoint.endsWith("/") ? endpoint : endpoint + "/";
  const relative = String(route ?? "").replace(/^\/+/, "");
  return new URL(relative, base);
}
