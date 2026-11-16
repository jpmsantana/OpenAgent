import fs from "node:fs/promises";
import path from "node:path";
import { isAbortError } from "../abort.js";
import { resolveWorkspacePath } from "../workspace.js";
import {
  isEnoent,
  isSymlinkOpenError,
  nonEmptyString,
  toolError,
  type ToolContext,
} from "./common.js";

export async function deleteFile(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  const userPath = nonEmptyString(args.path);
  if (userPath === undefined) {
    return "Error: invalid arguments for delete_file";
  }

  let resolved: string;
  try {
    resolved = resolveWorkspacePath(ctx.workspaceRoot, userPath);
  } catch (err) {
    return toolError(err);
  }

  const rootReal = await fs.realpath(ctx.workspaceRoot);
  const checkPath = path.resolve(rootReal, userPath);
  try {
    const st = await fs.lstat(checkPath);
    if (st.isDirectory()) {
      return `Error: is a directory: ${userPath}`;
    }
    if (st.isSymbolicLink()) {
      return `Error: path escapes workspace: ${userPath}`;
    }
  } catch (err) {
    if (isEnoent(err)) {
      return `Error: not found: ${userPath}`;
    }
    return toolError(err);
  }

  const relPath = path.relative(rootReal, resolved) || ".";
  if (ctx.confirm === undefined) {
    return `User denied delete of ${relPath}.`;
  }
  const allowed = await ctx.confirm({
    name: "delete_file",
    path: relPath,
    preview: "",
  });
  if (!allowed) {
    return `User denied delete of ${relPath}.`;
  }

  try {
    await fs.unlink(resolved);
  } catch (err) {
    if (isAbortError(err)) {
      throw err;
    }
    if (isSymlinkOpenError(err)) {
      return `Error: path escapes workspace: ${userPath}`;
    }
    return toolError(err);
  }
  return `Deleted ${relPath}`;
}
