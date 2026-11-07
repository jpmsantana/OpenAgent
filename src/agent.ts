import type { ChatMessage, OllamaTool, ToolCall } from "./ollama.js";
import type { Tool, ToolContext } from "./tools.js";

export const AGENT_SYSTEM_PROMPT =
  "You are OpenAgent, a local coding assistant. The workspace is the current working directory. Use the provided tools to inspect and edit files. Never guess file contents; read them. Use run_command only to run programs such as tests, builds, and git. Pass argv as an array; there is no shell. You have no network tool.";

export const MAX_TOOL_ROUNDS = 8;

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

function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name: string }).name === "AbortError"
  );
}

function rethrowIfAbort(err: unknown, signal?: AbortSignal): void {
  if (isAbortError(err)) {
    throw err;
  }
  signal?.throwIfAborted();
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
      if (name === "run_command" && !result.startsWith("User denied command:")) {
        deps.output.write(`${result}\n`);
      }
      deps.messages.push({
        role: "tool",
        content: result,
        tool_name: name,
      });
      deps.signal?.throwIfAborted();
    }

    deps.signal?.throwIfAborted();
  }

  process.stderr.write(`Stopped after ${MAX_TOOL_ROUNDS} tool rounds.\n`);
}
