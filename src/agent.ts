import { rethrowIfAbort } from "./abort.js";
import type { ChatMessage, OllamaTool, ToolCall } from "./ollama.js";
import type { Tool, ToolContext } from "./tools.js";

export const AGENT_SYSTEM_PROMPT =
  "You are OpenAgent, a local coding assistant. The workspace is the current working directory. Use grep to find text; do not walk the tree with list_dir when a pattern search will do. Use read_file to inspect files; pass offset (1-based line) and limit to read a line window. Never guess file contents. Prefer str_replace to change an existing file; use write_file to create a new file or replace an entire file. Use delete_file to remove a file. Use run_command only to run programs such as tests, builds, and git. Pass argv as an array; there is no shell. You have no network tool. The user may type a at a permission prompt to allow that exact path or command for the rest of the session.";

export const MAX_TOOL_ROUNDS = 16;
export const TOOL_RESULT_MAX_CHARS = 32768;

export type RunTurnDeps = {
  host: string;
  model: string;
  messages: ChatMessage[];
  tools: Tool[];
  chatStream: typeof import("./ollama.js").chatStream;
  output: NodeJS.WritableStream;
  workspaceRoot: string;
  signal?: AbortSignal;
  confirm?: ToolContext["confirm"];
};

function truncatedField(value: unknown): unknown {
  if (typeof value === "string" && value.length > 80) {
    return `<truncated ${Buffer.byteLength(value, "utf8")} bytes>`;
  }
  return value;
}

function toolCallLine(name: string, args: Record<string, unknown>): string {
  let printed: unknown = args;
  if (
    name === "write_file" &&
    typeof args.content === "string" &&
    args.content.length > 80
  ) {
    printed = {
      path: args.path,
      content: `<truncated ${Buffer.byteLength(args.content, "utf8")} bytes>`,
    };
  } else if (
    name === "str_replace" &&
    ((typeof args.old_string === "string" && args.old_string.length > 80) ||
      (typeof args.new_string === "string" && args.new_string.length > 80))
  ) {
    printed = {
      path: args.path,
      old_string: truncatedField(args.old_string),
      new_string: truncatedField(args.new_string),
    };
  }
  return `tool: ${name} ${JSON.stringify(printed)}\n`;
}

function toOllamaTools(tools: Tool[]): OllamaTool[] | undefined {
  if (tools.length === 0) {
    return undefined;
  }
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

export async function runTurn(deps: RunTurnDeps): Promise<void> {
  if (deps.messages[0]?.role !== "system") {
    deps.messages.unshift({
      role: "system",
      content: AGENT_SYSTEM_PROMPT,
    });
  }

  const ollamaTools = toOllamaTools(deps.tools);
  const ctx: ToolContext = {
    workspaceRoot: deps.workspaceRoot,
    signal: deps.signal,
    confirm: deps.confirm,
  };

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    deps.signal?.throwIfAborted();

    let text = "";
    const calls: ToolCall[] = [];
    try {
      for await (const event of deps.chatStream(deps.host, {
        model: deps.model,
        messages: deps.messages,
        tools: ollamaTools,
        signal: deps.signal,
      })) {
        if (event.type === "text") {
          deps.output.write(event.text);
          text += event.text;
        } else {
          calls.push(...event.calls);
        }
      }
    } catch (err) {
      rethrowIfAbort(err, deps.signal);
      throw err;
    }

    deps.signal?.throwIfAborted();

    if (calls.length === 0) {
      if (text !== "") {
        deps.messages.push({ role: "assistant", content: text });
      }
      return;
    }

    deps.messages.push({
      role: "assistant",
      content: text,
      tool_calls: calls,
    });

    for (const call of calls) {
      deps.signal?.throwIfAborted();
      const name = call.function.name;
      const args = call.function.arguments;
      deps.output.write(toolCallLine(name, args));
      const tool = deps.tools.find((candidate) => candidate.name === name);
      let result: string;
      try {
        result =
          tool === undefined
            ? `Error: unknown tool: ${name}`
            : await tool.execute(args, ctx);
      } catch (err) {
        rethrowIfAbort(err, deps.signal);
        throw err;
      }
      if (name === "write_file" && result.startsWith("Wrote ")) {
        deps.output.write(`${result}\n`);
      }
      if (name === "str_replace" && result.startsWith("Replaced ")) {
        deps.output.write(`${result}\n`);
      }
      if (name === "delete_file" && result.startsWith("Deleted ")) {
        deps.output.write(`${result}\n`);
      }
      if (name === "run_command" && !result.startsWith("User denied command:")) {
        deps.output.write(`${result}\n`);
      }
      const stored =
        result.length > TOOL_RESULT_MAX_CHARS
          ? `${result.slice(0, TOOL_RESULT_MAX_CHARS)}\n[truncated]\n`
          : result;
      deps.messages.push({
        role: "tool",
        content: stored,
        tool_name: name,
      });
      deps.signal?.throwIfAborted();
    }

    deps.signal?.throwIfAborted();
  }

  process.stderr.write(`Stopped after ${MAX_TOOL_ROUNDS} tool rounds.\n`);
}
