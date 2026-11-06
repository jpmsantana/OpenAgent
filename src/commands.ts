export type Command =
  | { type: "help" }
  | { type: "clear" }
  | { type: "model"; name?: string }
  | { type: "exit" }
  | { type: "unknown"; raw: string };

export const HELP_TEXT = `Commands:
  /help           Show this help
  /clear          Clear conversation history
  /model          List models from Ollama
  /model <name>   Select a model
  /exit           Quit
`;

/** If `line` is a slash command, return it; otherwise return null (send to the model). */
export function parseCommand(line: string): Command | null {
  const trimmed = line.trim();
  if (trimmed === "" || !trimmed.startsWith("/")) {
    return null;
  }
  const [raw, ...rest] = trimmed.split(/\s+/);
  const arg = rest.join(" ");
  switch (raw) {
    case "/help":
      return { type: "help" };
    case "/clear":
      return arg === "" ? { type: "clear" } : { type: "unknown", raw };
    case "/model":
      return arg === "" ? { type: "model" } : { type: "model", name: arg };
    case "/exit":
      return { type: "exit" };
    default:
      return { type: "unknown", raw };
  }
}
