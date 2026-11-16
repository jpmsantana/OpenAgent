import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveWorkspacePath } from "../workspace.js";
import {
  READ_MAX_BYTES,
  isEnoent,
  isSymlinkOpenError,
  nonEmptyString,
  toolError,
  writePreview,
  type ToolContext,
} from "./common.js";

export async function writeFile(
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
