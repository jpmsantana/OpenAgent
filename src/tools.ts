import fs from "node:fs/promises";
import { WorkspacePathError, resolveWorkspacePath } from "./workspace.js";

export type ToolContext = {
  workspaceRoot: string;
  signal?: AbortSignal;
  confirm?: (info: {
    name: string;
    path: string;
    preview: string;
  }) => Promise<boolean>;
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

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
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

export function createReadTools(): Tool[] {
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
  ];
}
