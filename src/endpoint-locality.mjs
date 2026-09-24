// Loopback, RFC1918, link-local and bare intranet names count as local: data
// sent there may cross to another box, but it stays inside the operator's
// network. Shared by the doctor's endpoint check and the hybrid edit routing.
// Spec: docs/HYBRID_EDIT_V0.md HE-5 (one locality rule for both).
export function isLocalHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1" || host === "0.0.0.0" || host === "::") return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) return true;
  // A bare intranet name with no dot is not a public destination.
  if (!host.includes(".")) return true;
  return false;
}

// Host of an endpoint written with or without a scheme; null when unparseable.
export function endpointHost(endpoint) {
  if (typeof endpoint !== "string" || endpoint.trim() === "") return null;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(endpoint) ? endpoint : `http://${endpoint}`).hostname;
  } catch {
    return null;
  }
}
