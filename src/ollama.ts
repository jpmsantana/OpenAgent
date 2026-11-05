export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export class OllamaError extends Error {
  readonly status?: number;

  constructor(message: string, opts?: { status?: number; cause?: unknown }) {
    super(message, { cause: opts?.cause });
    this.name = "OllamaError";
    this.status = opts?.status;
  }
}

function trimSlash(host: string): string {
  return host.endsWith("/") ? host.slice(0, -1) : host;
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name: string }).name === "AbortError"
  );
}

async function ollamaFetch(
  host: string,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (isAbortError(err)) {
      throw err;
    }
    throw new OllamaError(`Cannot reach Ollama at ${host}`, { cause: err });
  }
}

function messageContent(parsed: unknown): string | undefined {
  if (parsed === null || typeof parsed !== "object") {
    return undefined;
  }
  const message = (parsed as { message?: unknown }).message;
  if (message === null || typeof message !== "object") {
    return undefined;
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string" && content.length > 0) {
    return content;
  }
  return undefined;
}

export async function listModels(
  host: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const response = await ollamaFetch(host, `${trimSlash(host)}/api/tags`, {
    signal,
  });
  if (!response.ok) {
    throw new OllamaError(`Ollama at ${host} returned ${response.status}`, {
      status: response.status,
    });
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch (err) {
    throw new OllamaError(`Malformed Ollama response from ${host}`, {
      cause: err,
    });
  }

  if (
    data === null ||
    typeof data !== "object" ||
    !Array.isArray((data as { models?: unknown }).models)
  ) {
    throw new OllamaError(`Malformed Ollama response from ${host}`);
  }

  return (data as { models: { name: string }[] }).models.map((model) => model.name);
}

export async function* chatStream(
  host: string,
  args: {
    model: string;
    messages: ChatMessage[];
    signal?: AbortSignal;
  },
): AsyncGenerator<string, void, void> {
  const response = await ollamaFetch(host, `${trimSlash(host)}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: args.model,
      messages: args.messages,
      stream: true,
    }),
    signal: args.signal,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new OllamaError(
      `Ollama at ${host} returned ${response.status}: ${text.slice(0, 200)}`,
      { status: response.status },
    );
  }

  if (!response.body) {
    throw new OllamaError(`Malformed Ollama stream from ${host}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        const last = parseStreamLine(host, buffer);
        if (last !== undefined) {
          yield last;
        }
        return;
      }

      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const content = parseStreamLine(host, buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (content !== undefined) {
          yield content;
        }
        newline = buffer.indexOf("\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseStreamLine(host: string, line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new OllamaError(`Malformed Ollama stream from ${host}`, { cause: err });
  }
  return messageContent(parsed);
}
