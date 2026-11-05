import readline from "node:readline";
import { HELP_TEXT, parseCommand } from "./commands.js";
import {
  OllamaError,
  type ChatMessage,
} from "./ollama.js";

export type ReplDeps = {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  host: string;
  initialModel?: string;
  listModels: typeof import("./ollama.js").listModels;
  chatStream: typeof import("./ollama.js").chatStream;
};

export async function runRepl(deps: ReplDeps): Promise<void> {
  let models: string[];
  try {
    models = await deps.listModels(deps.host);
  } catch {
    process.stderr.write(
      `Cannot reach Ollama at ${deps.host}. Start it with: ollama serve\n`,
    );
    throw new OllamaError(`Cannot reach Ollama at ${deps.host}`);
  }

  let currentModel: string | undefined;
  if (deps.initialModel !== undefined) {
    if (models.includes(deps.initialModel)) {
      currentModel = deps.initialModel;
    } else {
      process.stderr.write(
        `Model '${deps.initialModel}' is not on Ollama. Use /model to choose.\n`,
      );
    }
  } else if (models.length > 0) {
    currentModel = models[0];
  }

  deps.output.write(`OpenAgent  (ollama / ${currentModel ?? "none"})\n`);
  deps.output.write("Type /help for commands, /exit to quit.\n");

  const rl = readline.createInterface({
    input: deps.input,
    output: deps.output,
    prompt: "> ",
  });
  const messages: ChatMessage[] = [];
  const chat: { abort?: AbortController } = {};
  let quitting = false;

  function quit(): void {
    if (quitting) {
      return;
    }
    quitting = true;
    chat.abort?.abort();
    deps.output.write("\n");
    rl.close();
  }

  process.on("SIGINT", quit);
  rl.on("SIGINT", quit);

  try {
    let open = true;
    rl.on("close", () => {
      open = false;
      chat.abort?.abort();
    });
    rl.prompt();
    for await (const line of rl) {
      if (quitting) {
        break;
      }
      currentModel = await handleLine(
        deps,
        line,
        messages,
        currentModel,
        chat,
        quit,
      );
      if (open && !quitting) {
        rl.prompt();
      }
    }
  } finally {
    process.off("SIGINT", quit);
    rl.removeListener("SIGINT", quit);
    rl.close();
  }
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name: string }).name === "AbortError"
  );
}

async function handleLine(
  deps: ReplDeps,
  line: string,
  messages: ChatMessage[],
  currentModel: string | undefined,
  chat: { abort?: AbortController },
  quit: () => void,
): Promise<string | undefined> {
  const trimmed = line.trim();
  if (trimmed === "") {
    return currentModel;
  }

  const command = parseCommand(trimmed);
  if (command) {
    switch (command.type) {
      case "help":
        deps.output.write(HELP_TEXT);
        return currentModel;
      case "model":
        return handleModel(deps, currentModel, command.name);
      case "exit":
        quit();
        return currentModel;
      case "unknown":
        deps.output.write(
          `Unknown command: ${command.raw}. Type /help for commands.\n`,
        );
        return currentModel;
    }
  }

  if (currentModel === undefined) {
    deps.output.write("No model selected. Use /model to choose.\n");
    return currentModel;
  }

  messages.push({ role: "user", content: trimmed });
  const abort = new AbortController();
  chat.abort = abort;
  let fullText = "";
  try {
    for await (const event of deps.chatStream(deps.host, {
      model: currentModel,
      messages,
      signal: abort.signal,
    })) {
      if (event.type === "text") {
        deps.output.write(event.text);
        fullText += event.text;
      }
    }
    deps.output.write("\n");
    if (fullText !== "") {
      messages.push({ role: "assistant", content: fullText });
    }
  } catch (err) {
    if (isAbortError(err) || abort.signal.aborted) {
      return currentModel;
    }
    if (err instanceof OllamaError) {
      process.stderr.write(`Error: ${err.message}\n`);
      return currentModel;
    }
    throw err;
  } finally {
    chat.abort = undefined;
  }
  return currentModel;
}

async function handleModel(
  deps: ReplDeps,
  currentModel: string | undefined,
  name?: string,
): Promise<string | undefined> {
  let models: string[];
  try {
    models = await deps.listModels(deps.host);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    return currentModel;
  }

  if (name !== undefined) {
    if (models.includes(name)) {
      deps.output.write(`Model set to ${name}\n`);
      return name;
    }
    process.stderr.write(
      `Model '${name}' is not available on Ollama. Use /model to list.\n`,
    );
    return currentModel;
  }

  deps.output.write(`Current: ${currentModel ?? "(none)"}\n`);
  if (models.length === 0) {
    deps.output.write(`No models found on Ollama at ${deps.host}.\n`);
    deps.output.write("Pull one with: ollama pull <name>\n");
    return currentModel;
  }
  deps.output.write(`Available from Ollama at ${deps.host}:\n`);
  for (const model of models) {
    deps.output.write(`  ${model}\n`);
  }
  deps.output.write("Use `/model <name>` to switch.\n");
  return currentModel;
}
