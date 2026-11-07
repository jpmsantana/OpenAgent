import { spawn } from "node:child_process";
import path from "node:path";
import { resolveWorkspacePath } from "./workspace.js";

export const COMMAND_TIMEOUT_MS = 30_000;
export const COMMAND_MAX_BYTES = 32_768;

export type RunCommandOpts = {
  argv: string[];
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
};

export type RunCommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
};

export class ExecArgvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecArgvError";
  }
}

function withTrailingNl(s: string): string {
  if (s === "") {
    return "";
  }
  return s.endsWith("\n") ? s : `${s}\n`;
}

export function formatCommandResult(
  result: RunCommandResult,
  timeoutMs = COMMAND_TIMEOUT_MS,
): string {
  const code = result.exitCode === null ? "killed" : String(result.exitCode);
  let body = `exit ${code}\nstdout:\n${withTrailingNl(result.stdout)}stderr:\n${withTrailingNl(result.stderr)}`;
  if (result.timedOut) {
    body = `Error: command timed out after ${timeoutMs} ms\n${body}`;
  }
  if (result.truncated) {
    body = `${body.endsWith("\n") ? body : `${body}\n`}[truncated]\n`;
  }
  return body;
}

function validateArgv(argv: string[]): void {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new ExecArgvError("Error: invalid arguments for run_command");
  }
  for (const part of argv) {
    if (typeof part !== "string" || part.includes("\0")) {
      throw new ExecArgvError("Error: invalid arguments for run_command");
    }
  }
  if (argv[0].length === 0) {
    throw new ExecArgvError("Error: invalid arguments for run_command");
  }
}

function resolveProgram(cwd: string, program: string): string {
  if (
    path.isAbsolute(program) ||
    program.includes("/") ||
    program.includes("\\")
  ) {
    return resolveWorkspacePath(cwd, program);
  }
  return program;
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || err.name === "TimeoutError")
  );
}

export async function runCommand(opts: RunCommandOpts): Promise<RunCommandResult> {
  validateArgv(opts.argv);
  const program = resolveProgram(opts.cwd, opts.argv[0]);
  const timeoutMs = opts.timeoutMs ?? COMMAND_TIMEOUT_MS;
  if (opts.signal?.aborted) {
    const err = new Error("This operation was aborted");
    err.name = "AbortError";
    throw err;
  }

  const timeout = AbortSignal.timeout(timeoutMs);
  const combined =
    opts.signal !== undefined ? AbortSignal.any([opts.signal, timeout]) : timeout;

  return await new Promise<RunCommandResult>((resolve, reject) => {
    let outBuf = Buffer.alloc(0);
    let errBuf = Buffer.alloc(0);
    let truncated = false;
    let settled = false;

    const child = spawn(program, opts.argv.slice(1), {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      signal: combined,
    });

    const fail = (err: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      reject(err);
    };

    const finish = (exitCode: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (opts.signal?.aborted) {
        const err = new Error("This operation was aborted");
        err.name = "AbortError";
        reject(err);
        return;
      }
      resolve({
        exitCode,
        stdout: outBuf.toString("utf8"),
        stderr: errBuf.toString("utf8"),
        timedOut: timeout.aborted && !opts.signal?.aborted,
        truncated,
      });
    };

    const append = (which: "out" | "err", chunk: Buffer): void => {
      if (truncated || settled) {
        return;
      }
      const total = outBuf.length + errBuf.length;
      if (total + chunk.length > COMMAND_MAX_BYTES) {
        const room = Math.max(0, COMMAND_MAX_BYTES - total);
        const take = chunk.subarray(0, room);
        if (which === "out") {
          outBuf = Buffer.concat([outBuf, take]);
        } else {
          errBuf = Buffer.concat([errBuf, take]);
        }
        truncated = true;
        child.kill("SIGKILL");
        return;
      }
      if (which === "out") {
        outBuf = Buffer.concat([outBuf, chunk]);
      } else {
        errBuf = Buffer.concat([errBuf, chunk]);
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      append("out", chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      append("err", chunk);
    });
    child.on("error", (err) => {
      if (isAbortError(err)) {
        return;
      }
      fail(err);
    });
    child.on("close", (code, signal) => {
      finish(code === null && signal !== null ? null : code);
    });
  });
}
