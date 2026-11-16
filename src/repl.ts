import readline from "node:readline";
import { runTurn } from "./agent.js";
import { HELP_TEXT, parseCommand } from "./commands.js";
import {
  OllamaError,
  type ChatMessage,
} from "./ollama.js";
import {
  SessionAllowlist,
  type FileAllowKind,
} from "./permissions.js";
import type { ConfirmInfo, Tool } from "./tools.js";

export type ReplDeps = {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  host: string;
  initialModel?: string;
  listModels: typeof import("./ollama.js").listModels;
  chatStream: typeof import("./ollama.js").chatStream;
  workspaceRoot: string;
  tools: Tool[];
};

type PermissionReply = { allowed: boolean; grant: boolean };

function fileKind(name: string): FileAllowKind | undefined {
  if (
    name === "write_file" ||
    name === "str_replace" ||
    name === "delete_file"
  ) {
    return name;
  }
  return undefined;
}

function alreadyAllowed(
  info: ConfirmInfo,
  allowlist?: SessionAllowlist,
): boolean {
  if (allowlist === undefined) {
    return false;
  }
  const kind = fileKind(info.name);
  if (kind !== undefined && info.path !== undefined && info.path !== "") {
    return allowlist.allowsFile(kind, info.path);
  }
  if (
    info.name === "run_command" &&
    info.argv !== undefined &&
    info.argv.length > 0
  ) {
    return allowlist.allowsCommand(info.argv);
  }
  return false;
}

function applyGrant(info: ConfirmInfo, allowlist?: SessionAllowlist): void {
  if (allowlist === undefined) {
    return;
  }
  const kind = fileKind(info.name);
  if (kind !== undefined && info.path !== undefined && info.path !== "") {
    allowlist.grantFile(kind, info.path);
    return;
  }
  if (
    info.name === "run_command" &&
    info.argv !== undefined &&
    info.argv.length > 0
  ) {
    allowlist.grantCommand(info.argv);
  }
}

async function askPermission(
  rl: readline.Interface,
  output: NodeJS.WritableStream,
  signal?: AbortSignal,
): Promise<PermissionReply> {
  if (signal?.aborted) {
    return { allowed: false, grant: false };
  }
  const answer = await new Promise<string>((resolve) => {
    let settled = false;
    const onAbort = (): void => {
      finish("");
    };
    const finish = (value: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    signal?.addEventListener("abort", onAbort);
    const onReply = (reply: string): void => {
      finish(reply);
    };
    if (signal !== undefined) {
      rl.question("", { signal }, onReply);
    } else {
      rl.question("", onReply);
    }
  });
  if (signal?.aborted) {
    return { allowed: false, grant: false };
  }
  const token = answer.trim();
  if (token === "y") {
    return { allowed: true, grant: false };
  }
  if (token === "a") {
    return { allowed: true, grant: true };
  }
  output.write("denied\n");
  return { allowed: false, grant: false };
}

/** Ask y/N/a for a write. Trimmed `y` allows once; `a` grants. Abort denies. */
export async function confirmWrite(
  rl: readline.Interface,
  output: NodeJS.WritableStream,
  info: ConfirmInfo,
  signal?: AbortSignal,
  allowlist?: SessionAllowlist,
): Promise<boolean> {
  if (signal?.aborted) {
    return false;
  }
  if (info.path === undefined) {
    return false;
  }
  const bytes = info.bytes ?? 0;
  output.write(`Allow write to ${info.path} (${bytes} bytes)? [y/N/a]\n`);
  if (info.preview !== "") {
    for (const line of info.preview.split("\n")) {
      output.write(`  ${line}\n`);
    }
  }
  const reply = await askPermission(rl, output, signal);
  if (reply.grant) {
    applyGrant(info, allowlist);
  }
  return reply.allowed;
}

/** Ask y/N/a for a replace. Trimmed `y` allows once; `a` grants. Abort denies. */
export async function confirmReplace(
  rl: readline.Interface,
  output: NodeJS.WritableStream,
  info: ConfirmInfo,
  signal?: AbortSignal,
  allowlist?: SessionAllowlist,
): Promise<boolean> {
  if (signal?.aborted) {
    return false;
  }
  if (info.path === undefined) {
    return false;
  }
  output.write(`Allow replace in ${info.path}? [y/N/a]\n`);
  if (info.preview !== "") {
    for (const line of info.preview.split("\n")) {
      output.write(`  ${line}\n`);
    }
  }
  const reply = await askPermission(rl, output, signal);
  if (reply.grant) {
    applyGrant(info, allowlist);
  }
  return reply.allowed;
}

/** Ask y/N/a for a command. Trimmed `y` allows once; `a` grants. Abort denies. */
export async function confirmCommand(
  rl: readline.Interface,
  output: NodeJS.WritableStream,
  info: ConfirmInfo,
  signal?: AbortSignal,
  allowlist?: SessionAllowlist,
): Promise<boolean> {
  if (signal?.aborted) {
    return false;
  }
  output.write(`Allow command ${info.preview}? [y/N/a]\n`);
  const reply = await askPermission(rl, output, signal);
  if (reply.grant) {
    applyGrant(info, allowlist);
  }
  return reply.allowed;
}

/** Ask y/N/a for a delete. Trimmed `y` allows once; `a` grants. Abort denies. */
export async function confirmDelete(
  rl: readline.Interface,
  output: NodeJS.WritableStream,
  info: ConfirmInfo,
  signal?: AbortSignal,
  allowlist?: SessionAllowlist,
): Promise<boolean> {
  if (signal?.aborted) {
    return false;
  }
  if (info.path === undefined) {
    return false;
  }
  output.write(`Allow delete ${info.path}? [y/N/a]\n`);
  const reply = await askPermission(rl, output, signal);
  if (reply.grant) {
    applyGrant(info, allowlist);
  }
  return reply.allowed;
}

/** Dispatch y/N/a by tool name. Unknown names are denied. Session grants skip the prompt. */
export async function confirm(
  rl: readline.Interface,
  output: NodeJS.WritableStream,
  info: ConfirmInfo,
  signal?: AbortSignal,
  allowlist?: SessionAllowlist,
): Promise<boolean> {
  if (alreadyAllowed(info, allowlist)) {
    return true;
  }
  if (info.name === "write_file") {
    return confirmWrite(rl, output, info, signal, allowlist);
  }
  if (info.name === "run_command") {
    return confirmCommand(rl, output, info, signal, allowlist);
  }
  if (info.name === "str_replace") {
    return confirmReplace(rl, output, info, signal, allowlist);
  }
  if (info.name === "delete_file") {
    return confirmDelete(rl, output, info, signal, allowlist);
  }
  return false;
}

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
  deps.output.write(`Workspace: ${deps.workspaceRoot}\n`);
  deps.output.write("Type /help for commands, /exit to quit.\n");

  const rl = readline.createInterface({
    input: deps.input,
    output: deps.output,
    prompt: "> ",
  });
  const messages: ChatMessage[] = [];
  const chat: { abort?: AbortController } = {};
  const allowlist = new SessionAllowlist();
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

  function onSigint(): void {
    if (chat.abort !== undefined) {
      if (!chat.abort.signal.aborted) {
        deps.output.write("\ncancelled\n");
        chat.abort.abort();
      }
      return;
    }
    quit();
  }

  process.on("SIGINT", onSigint);
  rl.on("SIGINT", onSigint);

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
        (info) =>
          confirm(rl, deps.output, info, chat.abort?.signal, allowlist),
        allowlist,
      );
      if (open && !quitting) {
        rl.prompt();
      }
    }
  } finally {
    process.off("SIGINT", onSigint);
    rl.removeListener("SIGINT", onSigint);
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

function writeAllows(
  output: NodeJS.WritableStream,
  allowlist: SessionAllowlist,
): void {
  const grants = allowlist.list();
  if (grants.length === 0) {
    output.write("No session allows.\n");
    return;
  }
  output.write("Session allows:\n");
  for (const grant of grants) {
    if (grant.kind === "run_command") {
      output.write(`  run_command ${JSON.stringify(grant.argv)}\n`);
    } else {
      output.write(`  ${grant.kind}  ${grant.path}\n`);
    }
  }
}

async function handleLine(
  deps: ReplDeps,
  line: string,
  messages: ChatMessage[],
  currentModel: string | undefined,
  chat: { abort?: AbortController },
  quit: () => void,
  confirm: (info: ConfirmInfo) => Promise<boolean>,
  allowlist: SessionAllowlist,
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
      case "clear":
        messages.length = 0;
        deps.output.write("Conversation cleared.\n");
        return currentModel;
      case "allow":
        if (command.clear) {
          allowlist.clear();
          deps.output.write("Session allows cleared.\n");
        } else {
          writeAllows(deps.output, allowlist);
        }
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
  try {
    await runTurn({
      host: deps.host,
      model: currentModel,
      messages,
      tools: deps.tools,
      chatStream: deps.chatStream,
      output: deps.output,
      workspaceRoot: deps.workspaceRoot,
      signal: abort.signal,
      confirm,
    });
    deps.output.write("\n");
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
