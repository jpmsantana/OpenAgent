import fs from "node:fs/promises";
import { resolveWorkspacePath } from "../workspace.js";
import {
  READ_MAX_BYTES,
  isEnoent,
  isPositiveInt,
  nonEmptyString,
  splitLines,
  toolError,
  type ToolContext,
} from "./common.js";

export async function readFile(
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
