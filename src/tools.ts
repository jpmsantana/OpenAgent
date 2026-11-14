import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ExecArgvError,
  formatCommandResult,
  runCommand,
  type RunCommandOpts,
  type RunCommandResult,
} from "./exec.js";
import { WorkspacePathError, resolveWorkspacePath } from "./workspace.js";

export type ConfirmInfo = {
  name: string;
  preview: string;
  path?: string;
  bytes?: number;
  argv?: string[];
};

export type ToolContext = {
  workspaceRoot: string;
  signal?: AbortSignal;
  confirm?: (info: ConfirmInfo) => Promise<boolean>;
  run?: (opts: RunCommandOpts) => Promise<RunCommandResult>;
};

export type Tool = {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  execute: (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<string>;
};

export const READ_MAX_BYTES = 262144;
export const GREP_MAX_MATCHES = 50;
export const GREP_MAX_FILES = 500;
export const GREP_MAX_LINE_CHARS = 200;
export const GREP_SKIP_DIR_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
]);

function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name: string }).name === "AbortError"
  );
}

function toolError(err: unknown): string {
  if (err instanceof WorkspacePathError || err instanceof ExecArgvError) {
    return err.message;
  }
  const message = err instanceof Error ? err.message : String(err);
  return `Error: ${message}`;
}

function errCode(err: unknown): unknown {
  return typeof err === "object" && err !== null && "code" in err
    ? (err as { code: unknown }).code
    : undefined;
}

function isEnoent(err: unknown): boolean {
  return errCode(err) === "ENOENT";
}

function isSymlinkOpenError(err: unknown): boolean {
  const code = errCode(err);
  return code === "ELOOP" || code === "EMLINK";
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function direntType(
  ent: { isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean },
): "file" | "dir" | "symlink" | "other" {
  if (ent.isSymbolicLink()) {
    return "symlink";
  }
  if (ent.isDirectory()) {
    return "dir";
  }
  if (ent.isFile()) {
    return "file";
  }
  return "other";
}

async function listDir(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  const userPath = nonEmptyString(args.path) ?? ".";
  try {
    const resolved = resolveWorkspacePath(ctx.workspaceRoot, userPath);
    const st = await fs.stat(resolved);
    if (!st.isDirectory()) {
      return `Error: not a directory: ${userPath}`;
    }
    const ents = await fs.readdir(resolved, { withFileTypes: true });
    const entries = ents
      .filter((ent) => ent.name !== "." && ent.name !== "..")
      .map((ent) => ({ name: ent.name, type: direntType(ent) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return JSON.stringify({ path: userPath, entries });
  } catch (err) {
    return toolError(err);
  }
}

async function readFile(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  const userPath = nonEmptyString(args.path);
  if (userPath === undefined) {
    return "Error: invalid arguments for read_file";
  }
  let offset: number | undefined;
  if (args.offset !== undefined) {
    if (!isPositiveInt(args.offset)) {
      return "Error: invalid arguments for read_file";
    }
    offset = args.offset;
  }
  let limit: number | undefined;
  if (args.limit !== undefined) {
    if (!isPositiveInt(args.limit)) {
      return "Error: invalid arguments for read_file";
    }
    limit = args.limit;
  }
  try {
    const resolved = resolveWorkspacePath(ctx.workspaceRoot, userPath);
    let st: Awaited<ReturnType<typeof fs.stat>>;
    try {
      st = await fs.stat(resolved);
    } catch (err) {
      if (isEnoent(err)) {
        return `Error: not found: ${userPath}`;
      }
      throw err;
    }
    if (st.isDirectory()) {
      return `Error: is a directory: ${userPath}`;
    }
    if (st.size > READ_MAX_BYTES) {
      return `Error: file too large: ${userPath}`;
    }
    const buf = await fs.readFile(resolved);
    if (buf.includes(0)) {
      return `Error: binary file: ${userPath}`;
    }
    const text = buf.toString("utf8");
    if (offset === undefined && limit === undefined) {
      return text;
    }
    const start = offset ?? 1;
    const lines = splitLines(text);
    const total = lines.length;
    if (start > total) {
      return `lines 0-0 of ${total}\n`;
    }
    const end = limit !== undefined ? Math.min(total, start + limit - 1) : total;
    const slice = lines.slice(start - 1, end).join("\n");
    return `lines ${start}-${end} of ${total}\n${slice}`;
  } catch (err) {
    return toolError(err);
  }
}

type GrepMatch = {
  relPath: string;
  line: number;
  text: string;
};

type GrepState = {
  regex: RegExp;
  rootReal: string;
  signal?: AbortSignal;
  matches: GrepMatch[];
  filesOpened: number;
  truncated: boolean;
};

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function formatGrepLine(line: string): string {
  if (line.length > GREP_MAX_LINE_CHARS) {
    return `${line.slice(0, GREP_MAX_LINE_CHARS)}...`;
  }
  return line;
}

function formatGrepResult(state: GrepState): string {
  if (state.matches.length === 0) {
    return state.truncated ? "No matches.\n[truncated]\n" : "No matches.";
  }
  const body = state.matches
    .map((match) => `${match.relPath}:${match.line}:${match.text}`)
    .join("\n");
  if (state.truncated) {
    return `${body}\n[truncated]\n`;
  }
  return body;
}

async function grepFile(filePath: string, state: GrepState): Promise<void> {
  state.signal?.throwIfAborted();
  if (state.truncated) {
    return;
  }
  if (state.filesOpened >= GREP_MAX_FILES) {
    state.truncated = true;
    return;
  }
  state.filesOpened += 1;
  const st = await fs.stat(filePath);
  if (st.size > READ_MAX_BYTES) {
    return;
  }
  const buf = await fs.readFile(filePath);
  if (buf.includes(0)) {
    return;
  }
  const relPath = path.relative(state.rootReal, filePath) || ".";
  const lines = splitLines(buf.toString("utf8"));
  for (let i = 0; i < lines.length; i++) {
    if (state.regex.test(lines[i])) {
      if (state.matches.length >= GREP_MAX_MATCHES) {
        state.truncated = true;
        return;
      }
      state.matches.push({
        relPath,
        line: i + 1,
        text: formatGrepLine(lines[i]),
      });
    }
  }
}

async function walkGrepDir(dirPath: string, state: GrepState): Promise<void> {
  if (state.truncated) {
    return;
  }
  state.signal?.throwIfAborted();
  const ents = await fs.readdir(dirPath, { withFileTypes: true });
  ents.sort((a, b) => a.name.localeCompare(b.name));
  state.signal?.throwIfAborted();
  for (const ent of ents) {
    if (state.truncated) {
      return;
    }
    if (ent.name === "." || ent.name === "..") {
      continue;
    }
    if (ent.isSymbolicLink()) {
      continue;
    }
    const full = path.join(dirPath, ent.name);
    if (ent.isDirectory()) {
      if (GREP_SKIP_DIR_NAMES.has(ent.name)) {
        continue;
      }
      await walkGrepDir(full, state);
    } else if (ent.isFile()) {
      await grepFile(full, state);
    }
  }
}

async function grep(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  const pattern = nonEmptyString(args.pattern);
  if (pattern === undefined) {
    return "Error: invalid arguments for grep";
  }
  if (args.path !== undefined && nonEmptyString(args.path) === undefined) {
    return "Error: invalid arguments for grep";
  }
  if (
    args.case_insensitive !== undefined &&
    typeof args.case_insensitive !== "boolean"
  ) {
    return "Error: invalid arguments for grep";
  }
  const userPath = nonEmptyString(args.path) ?? ".";
  const caseInsensitive = args.case_insensitive === true;

  try {
    ctx.signal?.throwIfAborted();
    const resolved = resolveWorkspacePath(ctx.workspaceRoot, userPath);
    let st: Awaited<ReturnType<typeof fs.stat>>;
    try {
      st = await fs.stat(resolved);
    } catch (err) {
      if (isEnoent(err)) {
        return `Error: not found: ${userPath}`;
      }
      throw err;
    }
    if (!st.isFile() && !st.isDirectory()) {
      return `Error: not a file or directory: ${userPath}`;
    }

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, caseInsensitive ? "i" : "");
    } catch {
      return "Error: invalid regex";
    }

    const rootReal = await fs.realpath(ctx.workspaceRoot);
    const state: GrepState = {
      regex,
      rootReal,
      signal: ctx.signal,
      matches: [],
      filesOpened: 0,
      truncated: false,
    };
    if (st.isFile()) {
      await grepFile(resolved, state);
    } else {
      await walkGrepDir(resolved, state);
    }
    return formatGrepResult(state);
  } catch (err) {
    if (isAbortError(err) || ctx.signal?.aborted) {
      throw err;
    }
    return toolError(err);
  }
}

function writePreview(content: string): string {
  if (content === "") {
    return "";
  }
  const lines = content.split("\n");
  const shown = lines
    .slice(0, 8)
    .map((line) => (line.length > 120 ? line.slice(0, 120) : line));
  if (lines.length > 8) {
    shown.push("...");
  }
  return shown.join("\n");
}

async function writeFile(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  const userPath = nonEmptyString(args.path);
  if (userPath === undefined || typeof args.content !== "string") {
    return "Error: invalid arguments for write_file";
  }
  const content = args.content;
  const n = Buffer.byteLength(content, "utf8");
  if (n > READ_MAX_BYTES) {
    return `Error: file too large: ${userPath}`;
  }

  let resolved: string;
  try {
    resolved = resolveWorkspacePath(ctx.workspaceRoot, userPath);
  } catch (err) {
    return toolError(err);
  }

  try {
    const st = await fs.lstat(resolved);
    if (st.isDirectory()) {
      return `Error: is a directory: ${userPath}`;
    }
    if (st.isSymbolicLink()) {
      return `Error: path escapes workspace: ${userPath}`;
    }
  } catch (err) {
    if (!isEnoent(err)) {
      return toolError(err);
    }
  }

  const rootReal = await fs.realpath(ctx.workspaceRoot);
  const relPath = path.relative(rootReal, resolved) || ".";
  if (ctx.confirm === undefined) {
    return `User denied write to ${relPath}.`;
  }

  const allowed = await ctx.confirm({
    name: "write_file",
    path: relPath,
    preview: writePreview(content),
    bytes: n,
  });
  if (!allowed) {
    return `User denied write to ${relPath}.`;
  }

  try {
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    const handle = await fs.open(
      resolved,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_TRUNC |
        fsConstants.O_NOFOLLOW,
    );
    try {
      await handle.writeFile(content, "utf8");
    } finally {
      await handle.close();
    }
  } catch (err) {
    if (isSymlinkOpenError(err)) {
      return `Error: path escapes workspace: ${userPath}`;
    }
    return toolError(err);
  }
  return `Wrote ${n} bytes to ${relPath}`;
}

function isArgv(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((part) => typeof part === "string") &&
    value[0] !== ""
  );
}

async function runCommandTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  if (!isArgv(args.argv)) {
    return "Error: invalid arguments for run_command";
  }
  const argv = args.argv;
  if (ctx.confirm === undefined) {
    return `User denied command: ${JSON.stringify(argv)}`;
  }
  const allowed = await ctx.confirm({
    name: "run_command",
    preview: JSON.stringify(argv),
    argv,
  });
  if (!allowed) {
    return `User denied command: ${JSON.stringify(argv)}`;
  }
  const run = ctx.run ?? runCommand;
  try {
    const result = await run({
      argv,
      cwd: ctx.workspaceRoot,
      signal: ctx.signal,
    });
    return formatCommandResult(result);
  } catch (err) {
    if (isAbortError(err) || ctx.signal?.aborted) {
      throw err;
    }
    return toolError(err);
  }
}

export function createTools(): Tool[] {
  return [
    {
      name: "list_dir",
      description:
        "List files and directories at a path inside the workspace. Not recursive.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory relative to the workspace root. Defaults to .",
          },
        },
      },
      execute: listDir,
    },
    {
      name: "read_file",
      description:
        "Read a UTF-8 text file inside the workspace. Optional offset (1-based line) and limit window the result. Fails on missing files, directories, binaries, or files larger than 262144 bytes.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: {
            type: "number",
            description: "1-based line to start reading. Optional.",
          },
          limit: {
            type: "number",
            description: "Maximum number of lines to return. Optional.",
          },
        },
        required: ["path"],
      },
      execute: readFile,
    },
    {
      name: "grep",
      description:
        "Search workspace files for a regular expression. Returns path:line:text. Skips node_modules, .git, and dist. Caps at 50 matches. Auto-allow.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description:
              "JavaScript regular expression source. Not a /slash/-wrapped literal.",
          },
          path: {
            type: "string",
            description:
              "File or directory relative to the workspace root. Defaults to .",
          },
          case_insensitive: {
            type: "boolean",
            description: "If true, compile the regex with the i flag. Default false.",
          },
        },
        required: ["pattern"],
      },
      execute: grep,
    },
    {
      name: "write_file",
      description:
        "Create or overwrite a UTF-8 text file inside the workspace. The user must approve each write. Creates parent directories if needed.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
      execute: writeFile,
    },
    {
      name: "run_command",
      description:
        "Run a program in the workspace directory. argv is an array: the program and its arguments. No shell. The user must approve each command.",
      parameters: {
        type: "object",
        properties: {
          argv: {
            type: "array",
            items: { type: "string" },
            description:
              "Program and arguments. First element is the executable. No shell.",
          },
        },
        required: ["argv"],
      },
      execute: runCommandTool,
    },
  ];
}
