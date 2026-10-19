// Host-only disposable-job reference. No physical isolation or egress enforcement:
// this fixed CPU workload is eligible precisely because it performs no I/O except stdout.
// Never extend this boundary to user code on the strength of a profile name.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

const SOURCE = '"use strict";let sum=0;for(let i=0;i<1000;i++)sum+=i;process.stdout.write(String(sum)+"\\n");';
export const REFERENCE_EXECUTION = Object.freeze({
  templateId: "reference-cpu", templateVersion: 1,
  scriptSha256: createHash("sha256").update(SOURCE, "utf8").digest("hex"),
});

export interface ExecRequest {
  leaseId: string;
  templateId: string;
  templateVersion: number;
  scriptSha256: string;
  timeoutMs: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

/** Owner configuration supplied in process, never deserialized from a job request.
 * Owner must protect executable and working directory against replacement and
 * authorize the lease AND exact pins for each invocation (including replay policy).
 */
export interface ExecHost {
  executablePath: string;
  managedCwd: string;
  authorize: (request: Readonly<ExecRequest>) => boolean | Promise<boolean>;
  /** In-process owner staging hook; must return an opaque identifier, not a path. */
  stageStdout?: (bytes: Uint8Array) => string;
}

export type ExecOutcome = "exited" | "timed-out" | "start-failed" | "signalled";
export interface ExecResult {
  leaseId: string;
  outcome: ExecOutcome;
  exitCode: number | null;
  signal: string | null;
  resolvedBin: string;
  stdoutSha256: string;
  stdoutBytes: number;
  stderrTail: string;
  artifactRef?: string;
}
const bounded = (n: unknown, max: number): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n > 0 && n <= max;

export async function execBounded(input: ExecRequest, host?: ExecHost): Promise<ExecResult> {
  const failed = (message: string): ExecResult => ({
    leaseId: typeof input?.leaseId === "string" ? input.leaseId : "",
    outcome: "start-failed", exitCode: null, signal: null, resolvedBin: "",
    stdoutSha256: "", stdoutBytes: 0, stderrTail: message,
  });
  try {
    if (!input || typeof input !== "object" || Object.keys(input).some(key =>
      !["leaseId", "templateId", "templateVersion", "scriptSha256", "timeoutMs", "maxBytes", "signal"].includes(key)))
      return failed("denied: unsupported execution input");
    const req = Object.freeze({ ...input });
    const maxBytes = req.maxBytes === undefined ? 4 * 1024 : req.maxBytes;
    if (!host || typeof host.authorize !== "function" || !req.leaseId || typeof req.leaseId !== "string" ||
      req.templateId !== REFERENCE_EXECUTION.templateId || req.templateVersion !== REFERENCE_EXECUTION.templateVersion ||
      req.scriptSha256 !== REFERENCE_EXECUTION.scriptSha256 ||
      !bounded(req.timeoutMs, 60000) || !bounded(maxBytes, 1048576) ||
      (req.signal !== undefined && !(req.signal instanceof AbortSignal)))
      return failed("denied: invalid pins, authorization, or bounds");
    // Strings and callback are snapshotted before crossing the asynchronous authorization boundary.
    const { executablePath, managedCwd, authorize, stageStdout } = host;
    if (stageStdout !== undefined && typeof stageStdout !== "function")
      return failed("denied: invalid staging callback");
    if (!isAbsolute(executablePath) || realpathSync(executablePath) !== executablePath ||
      executablePath !== realpathSync(process.execPath) || !isAbsolute(managedCwd) ||
      realpathSync(managedCwd) !== managedCwd || !statSync(managedCwd).isDirectory())
      return failed("denied: noncanonical host configuration");
    if (await authorize(req) !== true) return failed("denied: unauthorized execution");
    const result = (outcome: ExecOutcome, exitCode: number | null, signal: string | null,
      stdout = Buffer.alloc(0), stderrTail = ""): ExecResult => {
      const value: ExecResult = {
        leaseId: req.leaseId, outcome, exitCode, signal, resolvedBin: executablePath,
        stdoutSha256: createHash("sha256").update(stdout).digest("hex"), stdoutBytes: stdout.length, stderrTail,
      };
      if (outcome === "exited" && stageStdout) {
        try {
          const ref = stageStdout(Uint8Array.from(stdout));
          if (typeof ref !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(ref))
            throw new Error("invalid artifact identifier");
          value.artifactRef = ref;
        } catch {
          return { ...value, outcome: "start-failed", exitCode: null, stderrTail: "stdout staging failed" };
        }
      }
      return value;
    };
    if (req.signal?.aborted) return result("signalled", null, "SIGKILL");
    // SOURCE is an immutable loaded string: the bytes hashed above are the bytes
    // passed inline. No mutable script file, runtime search, user flags or arguments.
    return await new Promise<ExecResult>((resolve) => {
      const grouped = process.platform !== "win32";
      const child = spawn(executablePath, ["--input-type=commonjs", "--eval", SOURCE], {
        cwd: managedCwd, env: { LANG: "C", LC_ALL: "C", TZ: "UTC" },
        shell: false, detached: grouped, stdio: ["ignore", "pipe", "pipe"],
      });
      let stopped: ExecOutcome | undefined;
      let bytes = 0;
      const chunks: Buffer[] = [];
      let stderr = "";
      const stop = (outcome: ExecOutcome) => {
        if (stopped) return;
        stopped = outcome;
        // POSIX group kill covers ordinary descendants, not escaped sessions.
        try { if (grouped && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); }
        catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
      };
      const timer = setTimeout(() => stop("timed-out"), req.timeoutMs);
      const abort = () => stop("signalled");
      req.signal?.addEventListener("abort", abort, { once: true });
      if (req.signal?.aborted) abort();
      child.stdout.on("data", (data: Buffer) => {
        const keep = data.subarray(0, Math.max(0, maxBytes - bytes));
        chunks.push(keep); bytes += data.length;
        if (bytes > maxBytes) stop("start-failed");
      });
      child.stderr.on("data", (data: Buffer) => {
        stderr = (stderr + Buffer.from(data.subarray(0, Math.max(0, maxBytes - bytes))).toString("utf8")).slice(-500);
        bytes += data.length;
        if (bytes > maxBytes) stop("start-failed");
      });
      const cleanup = () => { clearTimeout(timer); req.signal?.removeEventListener("abort", abort); };
      child.on("error", () => { cleanup(); resolve(result("start-failed", null, null, Buffer.concat(chunks), "execution failed")); });
      child.on("close", (code, signal) => {
        cleanup();
        resolve(result(stopped ?? (signal ? "signalled" : "exited"), stopped ? null : code,
          signal, Buffer.concat(chunks), stopped === "start-failed" ? "output limit exceeded" : stderr));
      });
    });
  } catch {
    // Do not return host paths, callback exceptions, or environment secrets.
    return failed("denied: execution validation failed");
  }
}
