// Loopback, RFC1918, link-local and bare intranet names count as local: data
// sent there may cross to another box, but it stays inside the operator's
// network. Shared by the doctor's endpoint check and the hybrid edit routing.
// Spec: docs/HYBRID_EDIT_V0.md HE-5 (one locality rule for both).
function parseIpv4(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number.parseInt(part, 10) : -1));
  return octets.every((value) => value >= 0 && value <= 255) ? octets : null;
}

export function isLocalHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1" || host === "0.0.0.0" || host === "::") return true;
  // Match ranges against a parsed address, never against the start of a name:
  // `192.168.evil.com` is a public host whose name merely begins like one.
  const octets = parseIpv4(host);
  if (octets) {
    const [a, b] = octets;
    if (a === 127 || a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
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
