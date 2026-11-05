import fs from "node:fs";
import path from "node:path";

export class WorkspacePathError extends Error {
  readonly code: "escapes" | "nul";

  constructor(message: string, code: "escapes" | "nul") {
    super(message);
    this.name = "WorkspacePathError";
    this.code = code;
  }
}

function escapeMessage(userPath: string): string {
  return `Error: path escapes workspace: ${userPath}`;
}

function isInsideWorkspace(rootReal: string, resolved: string): boolean {
  const rel = path.relative(rootReal, resolved);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  );
}

function resolveExisting(abs: string): string {
  const tail: string[] = [];
  let current = abs;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return abs;
    }
    tail.unshift(path.basename(current));
    current = parent;
  }
  return path.join(fs.realpathSync(current), ...tail);
}

/**
 * Resolve `userPath` against `workspaceRoot`.
 * Result is an absolute path that is `workspaceRoot` or a descendant.
 * Throws WorkspacePathError otherwise.
 */
export function resolveWorkspacePath(
  workspaceRoot: string,
  userPath: string,
): string {
  let rootReal: string;
  try {
    rootReal = fs.realpathSync(workspaceRoot);
    if (!fs.statSync(rootReal).isDirectory()) {
      throw new WorkspacePathError(escapeMessage(userPath), "escapes");
    }
  } catch (err) {
    if (err instanceof WorkspacePathError) {
      throw err;
    }
    throw new WorkspacePathError(escapeMessage(userPath), "escapes");
  }

  if (userPath.includes("\0")) {
    throw new WorkspacePathError(escapeMessage(userPath), "nul");
  }

  const input = userPath === "" ? "." : userPath;
  const abs = path.resolve(rootReal, input);
  const resolved = resolveExisting(abs);
  if (!isInsideWorkspace(rootReal, resolved)) {
    throw new WorkspacePathError(escapeMessage(userPath), "escapes");
  }
  return resolved;
}
