import { spawn } from "node:child_process";

// Same contract as Pi's `pi.exec` (spawn without a shell; resolves, never
// rejects; `killed` reports a timeout or abort), so modules written against
// Pi's exec run unchanged outside Pi.
export function nodeExec(command, args, { cwd, timeout, signal } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      resolve({ stdout: "", stderr: String(error?.message ?? error), code: 1, killed: false });
      return;
    }

    let stdout = "";
    let stderr = "";
    let killed = false;
    let settled = false;
    const kill = () => {
      if (killed) return;
      killed = true;
      child.kill("SIGTERM");
      setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 5000).unref();
    };
    const timer = timeout > 0 ? setTimeout(kill, timeout) : null;
    if (signal?.aborted) kill();
    else signal?.addEventListener("abort", kill, { once: true });

    const finish = (code, extraError = "") => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      resolve({ stdout, stderr: stderr + extraError, code, killed });
    };

    child.stdout.on("data", (data) => { stdout += data.toString(); });
    child.stderr.on("data", (data) => { stderr += data.toString(); });
    child.on("error", (error) => finish(1, String(error?.message ?? error)));
    child.on("close", (code) => finish(code ?? 1));
  });
}
