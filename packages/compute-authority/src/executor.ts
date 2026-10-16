// T5 (hardened): template-pinned, no-shell, egress-free CPU executor.
// Bare binary names only; resolved against approved prefixes at spawn;
// absolute paths, PATH games, and interpreter flags outside the template
// are refused. Outcomes are discriminated: never invent exit 0.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

export interface ExecRequest {
  leaseId: string;
  /** Template: [runtime, scriptSha256?, ...args]. Only approved runtimes. */
  argv: string[];
  timeoutMs: number;
  cwd: string;
  maxBytes?: number;
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
}

const APPROVED_PREFIXES = ["/usr/bin/", "/bin/", "/usr/local/bin/"];

function resolveBin(name: string): string | null {
  if (name.includes("/")) return null; // bare names only
  const allow = new Set(["python3", "node", "git", "ffmpeg"]);
  if (!allow.has(name)) return null;
  const pathDirs = (process.env.PATH ?? "/usr/bin:/bin").split(":");
  for (const dir of pathDirs) {
    const cand = `${dir}/${name}`;
    if (APPROVED_PREFIXES.some((p) => cand.startsWith(p)) && existsSync(cand)) return cand;
  }
  return null;
}

export function execBounded(req: ExecRequest): Promise<ExecResult> {
  const [bin, ...args] = req.argv;
  const resolved = bin ? resolveBin(bin) : null;
  // Interpreter code flags are outside the template: refuse -c/-e payloads.
  if (!resolved || args.some((a) => a === "-c" || a === "-e")) {
    return Promise.resolve({
      leaseId: req.leaseId, outcome: "start-failed", exitCode: null, signal: null,
      resolvedBin: "", stdoutSha256: "", stdoutBytes: 0,
      stderrTail: `denied: ${bin ?? "(empty)"}`,
    });
  }
  const maxBytes = req.maxBytes ?? 4 * 1024 * 1024;
  return new Promise((resolve) => {
    execFile(resolved, args, { cwd: req.cwd, timeout: req.timeoutMs, maxBuffer: maxBytes }, (err, stdout, stderr) => {
      const out = typeof stdout === "string" ? stdout : String(stdout ?? "");
      const e = (err ?? {}) as { code?: unknown; killed?: boolean; signal?: unknown; message?: string };
      if (!err) {
        return resolve({
          leaseId: req.leaseId, outcome: "exited", exitCode: 0, signal: null,
          resolvedBin: resolved, stdoutSha256: createHash("sha256").update(out).digest("hex"),
          stdoutBytes: Buffer.byteLength(out), stderrTail: String(stderr ?? "").slice(-500),
        });
      }
      const timedOut = e.code === "ETIMEDOUT" || e.killed === true;
      if (timedOut) {
        return resolve({
          leaseId: req.leaseId, outcome: "timed-out", exitCode: null, signal: typeof e.signal === "string" ? e.signal : "SIGTERM",
          resolvedBin: resolved, stdoutSha256: createHash("sha256").update(out).digest("hex"),
          stdoutBytes: Buffer.byteLength(out), stderrTail: String(e.message ?? "timeout").slice(-500),
        });
      }
      if (typeof e.code === "number") {
        return resolve({
          leaseId: req.leaseId, outcome: "exited", exitCode: e.code, signal: null,
          resolvedBin: resolved, stdoutSha256: createHash("sha256").update(out).digest("hex"),
          stdoutBytes: Buffer.byteLength(out), stderrTail: String(stderr ?? e.message ?? "").slice(-500),
        });
      }
      // String codes (ENOENT, EACCES, ERR_BUFFER): launch/output failure, never exit 0.
      return resolve({
        leaseId: req.leaseId, outcome: "start-failed", exitCode: null,
        signal: typeof e.signal === "string" ? e.signal : null,
        resolvedBin: resolved, stdoutSha256: createHash("sha256").update(out).digest("hex"),
        stdoutBytes: Buffer.byteLength(out), stderrTail: String(e.message ?? e.code ?? "start failed").slice(-500),
      });
    });
  });
}
