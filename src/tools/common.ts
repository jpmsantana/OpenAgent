import type { RunCommandOpts, RunCommandResult } from "../exec.js";
import { ExecArgvError } from "../exec.js";
import { WorkspacePathError } from "../workspace.js";

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

export function toolError(err: unknown): string {
  if (err instanceof WorkspacePathError || err instanceof ExecArgvError) {
    return err.message;
  }
  const message = err instanceof Error ? err.message : String(err);
  return `Error: ${message}`;
}

export function errCode(err: unknown): unknown {
  return typeof err === "object" && err !== null && "code" in err
    ? (err as { code: unknown }).code
    : undefined;
}

export function isEnoent(err: unknown): boolean {
  return errCode(err) === "ENOENT";
}

export function isSymlinkOpenError(err: unknown): boolean {
  const code = errCode(err);
  return code === "ELOOP" || code === "EMLINK";
}

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function direntType(
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

export function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

export function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

export function writePreview(content: string): string {
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
