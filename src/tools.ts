import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { WorkspacePathError, resolveWorkspacePath } from "./workspace.js";

export type ConfirmInfo = {
  name: string;
  path: string;
  preview: string;
  bytes?: number;
};

export type ToolContext = {
  workspaceRoot: string;
  signal?: AbortSignal;
  confirm?: (info: ConfirmInfo) => Promise<boolean>;
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

function toolError(err: unknown): string {
  if (err instanceof WorkspacePathError) {
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
    return buf.toString("utf8");
  } catch (err) {
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
        "Read a UTF-8 text file inside the workspace. Fails on missing files, directories, binaries, or files larger than 262144 bytes.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
      },
      execute: readFile,
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
  ];
}
