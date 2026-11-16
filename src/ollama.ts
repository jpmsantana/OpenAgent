import { isAbortError } from "./abort.js";

export type ToolCall = {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
};

export type OllamaTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
};

export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "tool_calls"; calls: ToolCall[] };

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const OLLAMA_TIMEOUT_MS = 60_000;

function rethrowIfTimedOutOrAborted(
  err: unknown,
  host: string,
  timeout: AbortSignal,
  caller?: AbortSignal,
): void {
  if (caller?.aborted) {
    caller.throwIfAborted();
    throw err;
  }
  if (timeout.aborted) {
    throw new OllamaError(`Ollama at ${host} timed out`, { cause: err });
  }
  if (isAbortError(err)) {
    throw err;
  }
}

async function ollamaFetch(
  host: string,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  caller?: AbortSignal,
): Promise<{ response: Response; timeout: AbortSignal }> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = caller ? AbortSignal.any([timeout, caller]) : timeout;
  try {
    const response = await fetch(url, { ...init, signal });
    return { response, timeout };
  } catch (err) {
    rethrowIfTimedOutOrAborted(err, host, timeout, caller);
    throw new OllamaError(`Cannot reach Ollama at ${host}`, { cause: err });
  }
}

function serializeMessage(message: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = {
    role: message.role,
    content: message.content,
  };
  if (message.tool_calls !== undefined && message.tool_calls.length > 0) {
    out.tool_calls = message.tool_calls;
  }
  if (message.role === "tool" && message.tool_name !== undefined) {
    out.tool_name = message.tool_name;
  }
  return out;
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (isPlainObject(value)) {
    return value;
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return isPlainObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function parseToolCalls(message: Record<string, unknown>): ToolCall[] {
  const raw = message.tool_calls;
  if (!Array.isArray(raw) || raw.length === 0) {
    return [];
  }
  const calls: ToolCall[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) {
      continue;
    }
    const fn = entry.function;
    if (!isPlainObject(fn) || typeof fn.name !== "string" || fn.name === "") {
      continue;
    }
    calls.push({
      function: {
        name: fn.name,
        arguments: parseToolArguments(fn.arguments),
      },
    });
  }
  return calls;
}

function eventsFromParsed(parsed: unknown): ChatEvent[] {
  if (!isPlainObject(parsed)) {
    return [];
  }
  const message = parsed.message;
  if (!isPlainObject(message)) {
    return [];
  }
  const events: ChatEvent[] = [];
  const content = message.content;
  if (typeof content === "string" && content.length > 0) {
    events.push({ type: "text", text: content });
  }
  const calls = parseToolCalls(message);
  if (calls.length > 0) {
    events.push({ type: "tool_calls", calls });
  }
  return events;
}

export async function listModels(
  host: string,
  signal?: AbortSignal,
  timeoutMs: number = OLLAMA_TIMEOUT_MS,
): Promise<string[]> {
  const { response, timeout } = await ollamaFetch(
    host,
    `${trimSlash(host)}/api/tags`,
    {},
    timeoutMs,
    signal,
  );
  if (!response.ok) {
    throw new OllamaError(`Ollama at ${host} returned ${response.status}`, {
      status: response.status,
    });
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch (err) {
    rethrowIfTimedOutOrAborted(err, host, timeout, signal);
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

  const names: string[] = [];
  for (const model of (data as { models: unknown[] }).models) {
    if (!isPlainObject(model)) {
      continue;
    }
    if (typeof model.name === "string" && model.name.length > 0) {
      names.push(model.name);
    }
  }
  return names;
}

export async function* chatStream(
  host: string,
  args: {
    model: string;
    messages: ChatMessage[];
    tools?: OllamaTool[];
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): AsyncGenerator<ChatEvent, void, void> {
  const body: Record<string, unknown> = {
    model: args.model,
    messages: args.messages.map(serializeMessage),
    stream: true,
  };
  if (args.tools !== undefined && args.tools.length > 0) {
    body.tools = args.tools;
  }

  const { response, timeout } = await ollamaFetch(
    host,
    `${trimSlash(host)}/api/chat`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    args.timeoutMs ?? OLLAMA_TIMEOUT_MS,
    args.signal,
  );

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
        for (const event of parseStreamLine(host, buffer)) {
          yield event;
        }
        return;
      }

      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const events = parseStreamLine(host, buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        for (const event of events) {
          yield event;
        }
        newline = buffer.indexOf("\n");
      }
    }
  } catch (err) {
    rethrowIfTimedOutOrAborted(err, host, timeout, args.signal);
    throw err;
  } finally {
    reader.releaseLock();
  }
}

function parseStreamLine(host: string, line: string): ChatEvent[] {
  const trimmed = line.trim();
  if (!trimmed) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new OllamaError(`Malformed Ollama stream from ${host}`, { cause: err });
  }
  return eventsFromParsed(parsed);
}
