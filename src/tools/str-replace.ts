import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isAbortError } from "../abort.js";
import { resolveWorkspacePath } from "../workspace.js";
import {
  READ_MAX_BYTES,
  isEnoent,
  isSymlinkOpenError,
  nonEmptyString,
  toolError,
  unfollowedWorkspacePath,
  writePreview,
  type ToolContext,
} from "./common.js";

export async function strReplace(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  const userPath = nonEmptyString(args.path);
  if (
    userPath === undefined ||
    typeof args.old_string !== "string" ||
    args.old_string.length === 0 ||
    typeof args.new_string !== "string"
  ) {
    return "Error: invalid arguments for str_replace";
  }
  const oldString = args.old_string;
  const newString = args.new_string;

  try {
    resolveWorkspacePath(ctx.workspaceRoot, userPath);
  } catch (err) {
    return toolError(err);
  }

  const { rootReal, linkPath } = await unfollowedWorkspacePath(
    ctx.workspaceRoot,
    userPath,
  );
  try {
    const st = await fs.lstat(linkPath);
    if (st.isDirectory()) {
      return `Error: is a directory: ${userPath}`;
    }
    if (st.isSymbolicLink()) {
      return `Error: path escapes workspace: ${userPath}`;
    }
    if (st.size > READ_MAX_BYTES) {
      return `Error: file too large: ${userPath}`;
    }
  } catch (err) {
    if (isEnoent(err)) {
      return `Error: not found: ${userPath}`;
    }
    return toolError(err);
  }

  let text: string;
  try {
    const buf = await fs.readFile(linkPath);
    if (buf.includes(0)) {
      return `Error: binary file: ${userPath}`;
    }
    text = buf.toString("utf8");
  } catch (err) {
    if (isAbortError(err)) {
      throw err;
    }
    return toolError(err);
  }

  const n = text.split(oldString).length - 1;
  if (n === 0) {
    return "Error: old_string not found";
  }
  if (n > 1) {
    return `Error: old_string matched ${n} times; must be unique`;
  }

  const next = text.replace(oldString, newString);
  if (Buffer.byteLength(next, "utf8") > READ_MAX_BYTES) {
    return `Error: file too large: ${userPath}`;
  }

  const relPath = path.relative(rootReal, linkPath) || ".";
  if (ctx.confirm === undefined) {
    return `User denied replace in ${relPath}.`;
  }

  const preview = `--- old ---\n${writePreview(oldString)}\n--- new ---\n${writePreview(newString)}`;
  const allowed = await ctx.confirm({
    name: "str_replace",
    path: relPath,
    preview,
    bytes: Buffer.byteLength(next, "utf8"),
  });
  if (!allowed) {
    return `User denied replace in ${relPath}.`;
  }

  try {
    const handle = await fs.open(
      linkPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_TRUNC |
        fsConstants.O_NOFOLLOW,
    );
    try {
      await handle.writeFile(next, "utf8");
    } finally {
      await handle.close();
    }
  } catch (err) {
    if (isAbortError(err)) {
      throw err;
    }
    if (isSymlinkOpenError(err)) {
      return `Error: path escapes workspace: ${userPath}`;
    }
    return toolError(err);
  }
  return `Replaced in ${relPath}`;
}
