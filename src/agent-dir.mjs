import os from "node:os";
import path from "node:path";

// Pi's getAgentDir() without importing Pi, for hosts that run the engine
// outside it (the MCP server): PI_CODING_AGENT_DIR, else ~/.pi/agent. The
// engine config then lives in the same file /offline-setup writes.
export function resolveAgentDir(env = process.env) {
  const dir = env.PI_CODING_AGENT_DIR;
  if (dir) return dir === "~" || dir.startsWith("~/") || dir.startsWith("~\\") ? path.join(os.homedir(), dir.slice(1)) : dir;
  return path.join(os.homedir(), ".pi", "agent");
}
