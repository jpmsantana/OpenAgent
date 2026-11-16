import fs from "node:fs/promises";
import { resolveWorkspacePath } from "../workspace.js";
import {
  direntType,
  nonEmptyString,
  toolError,
  type ToolContext,
} from "./common.js";

export async function listDir(
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
