import { isAbortError } from "../abort.js";
import { formatCommandResult, runCommand } from "../exec.js";
import { toolError, type ToolContext } from "./common.js";

function isArgv(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((part) => typeof part === "string") &&
    value[0] !== ""
  );
}

export async function runCommandTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  if (!isArgv(args.argv)) {
    return "Error: invalid arguments for run_command";
  }
  const argv = args.argv;
  if (ctx.confirm === undefined) {
    return `User denied command: ${JSON.stringify(argv)}`;
  }
  const allowed = await ctx.confirm({
    name: "run_command",
    preview: JSON.stringify(argv),
    argv,
  });
  if (!allowed) {
    return `User denied command: ${JSON.stringify(argv)}`;
  }
  const run = ctx.run ?? runCommand;
  try {
    const result = await run({
      argv,
      cwd: ctx.workspaceRoot,
      signal: ctx.signal,
    });
    return formatCommandResult(result);
  } catch (err) {
    if (isAbortError(err) || ctx.signal?.aborted) {
      throw err;
    }
    return toolError(err);
  }
}
