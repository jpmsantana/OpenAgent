import fs from "node:fs/promises";
import path from "node:path";
import { isAbortError } from "../abort.js";
import { resolveWorkspacePath } from "../workspace.js";
import {
  GREP_MAX_FILES,
  GREP_MAX_LINE_CHARS,
  GREP_MAX_MATCHES,
  GREP_SKIP_DIR_NAMES,
  READ_MAX_BYTES,
  isEnoent,
  nonEmptyString,
  splitLines,
  toolError,
  type ToolContext,
} from "./common.js";

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

export async function grep(
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
