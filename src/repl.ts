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

  try {
    let open = true;
    rl.on("close", () => {
      open = false;
    });
    rl.prompt();
    for await (const line of rl) {
      await handleLine(deps, line, messages, currentModel);
      if (open) {
        rl.prompt();
      }
    }
  } finally {
    rl.close();
  }
}

async function handleLine(
  deps: ReplDeps,
  line: string,
  messages: ChatMessage[],
  currentModel: string | undefined,
): Promise<void> {
  const trimmed = line.trim();
  if (trimmed === "") {
    return;
  }

  const command = parseCommand(trimmed);
  if (command) {
    switch (command.type) {
      case "help":
        deps.output.write(HELP_TEXT);
        return;
      case "model":
      case "exit":
        deps.output.write("Not implemented yet.\n");
        return;
      case "unknown":
        deps.output.write(
          `Unknown command: ${command.raw}. Type /help for commands.\n`,
        );
        return;
    }
  }

  if (currentModel === undefined) {
    deps.output.write("No model selected. Use /model to choose.\n");
    return;
  }

  messages.push({ role: "user", content: trimmed });
  let fullText = "";
  try {
    for await (const chunk of deps.chatStream(deps.host, {
      model: currentModel,
      messages,
    })) {
      deps.output.write(chunk);
      fullText += chunk;
    }
    deps.output.write("\n");
    if (fullText !== "") {
      messages.push({ role: "assistant", content: fullText });
    }
  } catch (err) {
    if (err instanceof OllamaError) {
      process.stderr.write(`Error: ${err.message}\n`);
      return;
    }
    throw err;
  }
}
