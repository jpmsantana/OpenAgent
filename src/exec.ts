import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { isAbortOrTimeoutError } from "./abort.js";
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

export const COMMAND_ENV_KEYS: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TZ",
  "NODE_ENV",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "WINDIR",
  "COMSPEC",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramFiles",
  "PROGRAMFILES",
  "ProgramData",
  "PROGRAMDATA",
];

export function sanitizeCommandEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of COMMAND_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

function killChild(child: ChildProcess): void {
  if (process.platform !== "win32" && typeof child.pid === "number") {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // ESRCH: already gone
    }
    return;
  }
  child.kill("SIGKILL");
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
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let settled = false;

    const spawned: { current?: ChildProcess } = {};
    combined.addEventListener(
      "abort",
      () => {
        if (spawned.current !== undefined) {
          killChild(spawned.current);
        }
      },
      { once: true },
    );
    const proc = spawn(program, opts.argv.slice(1), {
      cwd: opts.cwd,
      env: sanitizeCommandEnv(opts.env ?? process.env),
      shell: false,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      signal: combined,
    });
    spawned.current = proc;

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
      const timedOut = timeout.aborted && !opts.signal?.aborted;
      if (timedOut || opts.signal?.aborted) {
        killChild(proc);
      }
      if (opts.signal?.aborted) {
        const err = new Error("This operation was aborted");
        err.name = "AbortError";
        reject(err);
        return;
      }
      resolve({
        exitCode,
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        timedOut,
        truncated,
      });
    };

    const append = (which: "out" | "err", chunk: Buffer): void => {
      if (truncated || settled) {
        return;
      }
      if (size + chunk.length > COMMAND_MAX_BYTES) {
        const room = Math.max(0, COMMAND_MAX_BYTES - size);
        const take = chunk.subarray(0, room);
        if (take.length > 0) {
          if (which === "out") {
            outChunks.push(take);
          } else {
            errChunks.push(take);
          }
          size += take.length;
        }
        truncated = true;
        killChild(proc);
        return;
      }
      if (which === "out") {
        outChunks.push(chunk);
      } else {
        errChunks.push(chunk);
      }
      size += chunk.length;
    };

    proc.stdout?.on("data", (chunk: Buffer) => {
      append("out", chunk);
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      append("err", chunk);
    });
    proc.on("error", (err) => {
      if (isAbortOrTimeoutError(err)) {
        return;
      }
      fail(err);
    });
    proc.on("close", (code, signal) => {
      finish(code === null && signal !== null ? null : code);
    });
  });
}
