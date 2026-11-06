import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { describe, it } from "node:test";
import { AGENT_SYSTEM_PROMPT } from "./agent.ts";
import { OllamaError, type ChatMessage } from "./ollama.ts";
import { runRepl, type ReplDeps } from "./repl.ts";

function collect(): { output: Writable; text: () => string } {
  let buf = "";
  const output = new Writable({
    write(chunk, _enc, cb) {
      buf += String(chunk);
      cb();
    },
  });
  return { output, text: () => buf };
}

function input(lines: string[]): Readable {
  return Readable.from(lines.map((line) => `${line}\n`));
}

async function run(
  lines: string[],
  overrides: Partial<ReplDeps> = {},
): Promise<{ stdout: string; calls: Parameters<ReplDeps["chatStream"]>[] }> {
  const { output, text } = collect();
  const calls: Parameters<ReplDeps["chatStream"]>[] = [];
  const chatStream: ReplDeps["chatStream"] = async function* (host, args) {
    calls.push([host, { ...args, messages: [...args.messages] }]);
    yield { type: "text", text: "ok" };
  };
  await runRepl({
    input: input(lines),
    output,
    host: "http://127.0.0.1:11434",
    listModels: async () => ["m"],
    chatStream,
    workspaceRoot: "/workspace",
    tools: [],
    ...overrides,
  });
  return { stdout: text(), calls };
}

function hang(line: string): Readable {
  const stream = new Readable({ read() {} });
  stream.push(`${line}\n`);
  return stream;
}

describe("runRepl", { concurrency: 1 }, () => {
  it("streams chat chunks to stdout", async () => {
    const { stdout } = await run(["hello"]);
    assert.match(stdout, /OpenAgent {2}\(ollama \/ m\)/);
    assert.match(stdout, /Workspace: \/workspace/);
    assert.match(stdout, /ok/);
  });

  it("banner includes Workspace", async () => {
    const { stdout, calls } = await run([]);
    assert.match(stdout, /Workspace: /);
    assert.equal(calls.length, 0);
  });

  it("second turn includes prior user and assistant messages", async () => {
    const { calls } = await run(["hello", "again"]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0][1].tools, undefined);
    const second = calls[1][1].messages as ChatMessage[];
    assert.deepEqual(second, [
      { role: "system", content: AGENT_SYSTEM_PROMPT },
      { role: "user", content: "hello" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "again" },
    ]);
  });

  it("/help prints the command list", async () => {
    const { stdout, calls } = await run(["/help"]);
    assert.match(stdout, /Commands:/);
    assert.match(stdout, /\/exit/);
    assert.equal(calls.length, 0);
  });

  it("unreachable Ollama prints serve hint and throws", async () => {
    const { output, text } = collect();
    const writes: string[] = [];
    const orig = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await assert.rejects(
        () =>
          runRepl({
            input: input([]),
            output,
            host: "http://127.0.0.1:9",
            listModels: async () => {
              throw new OllamaError("Cannot reach Ollama at http://127.0.0.1:9");
            },
            chatStream: async function* () {},
            workspaceRoot: "/workspace",
            tools: [],
          }),
        OllamaError,
      );
      const stderr = writes.join("");
      assert.match(stderr, /Cannot reach Ollama at http:\/\/127\.0\.0\.1:9/);
      assert.match(stderr, /ollama serve/);
      assert.equal(text(), "");
    } finally {
      process.stderr.write = orig;
    }
  });

  it("no model selected refuses chat", async () => {
    const { stdout, calls } = await run(["hello"], {
      listModels: async () => [],
    });
    assert.match(stdout, /OpenAgent {2}\(ollama \/ none\)/);
    assert.match(stdout, /No model selected/);
    assert.equal(calls.length, 0);
  });

  it("/model lists current and available names", async () => {
    const { stdout } = await run(["/model"], {
      listModels: async () => ["a", "b"],
    });
    assert.match(stdout, /Current: a/);
    assert.match(stdout, /Available from Ollama at http:\/\/127\.0\.0\.1:11434:/);
    assert.match(stdout, /^ {2}a$/m);
    assert.match(stdout, /^ {2}b$/m);
    assert.match(stdout, /Use `\/model <name>` to switch/);
  });

  it("/model b then a user line chats with b", async () => {
    const { calls } = await run(["/model b", "hello"], {
      listModels: async () => ["a", "b"],
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].model, "b");
  });

  it("/model nope keeps the previous model", async () => {
    const writes: string[] = [];
    const orig = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const { calls } = await run(["/model nope", "hello"], {
        listModels: async () => ["a", "b"],
      });
      assert.match(writes.join(""), /not available/);
      assert.equal(calls.length, 1);
      assert.equal(calls[0][1].model, "a");
    } finally {
      process.stderr.write = orig;
    }
  });

  it("/model with an empty list prints no models found", async () => {
    const { stdout } = await run(["/model"], {
      listModels: async () => [],
    });
    assert.match(stdout, /Current: \(none\)/);
    assert.match(stdout, /No models found on Ollama at http:\/\/127\.0\.0\.1:11434/);
    assert.match(stdout, /ollama pull <name>/);
  });

  it("/exit resolves without calling chatStream", { timeout: 3000 }, async () => {
    const stream = hang("/exit");
    const { output } = collect();
    let calls = 0;
    try {
      await runRepl({
        input: stream,
        output,
        host: "http://127.0.0.1:11434",
        listModels: async () => ["m"],
        chatStream: async function* () {
          calls += 1;
          yield { type: "text", text: "ok" };
        },
        workspaceRoot: "/workspace",
        tools: [],
      });
      assert.equal(calls, 0);
    } finally {
      stream.destroy();
    }
  });

  it("SIGINT aborts in-flight chat and runRepl resolves", { timeout: 3000 }, async () => {
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      release = resolve;
    });
    let seenAbort = false;
    const stream = hang("hello");
    const { output } = collect();
    const done = runRepl({
      input: stream,
      output,
      host: "http://127.0.0.1:11434",
      listModels: async () => ["m"],
      chatStream: async function* (_host, args) {
        await new Promise<void>((_resolve, reject) => {
          const signal = args.signal;
          if (signal === undefined) {
            reject(new Error("missing signal"));
            return;
          }
          const fail = (): void => {
            seenAbort = true;
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          };
          if (signal.aborted) {
            fail();
            return;
          }
          signal.addEventListener("abort", fail, { once: true });
          release();
        });
        yield { type: "text", text: "ok" };
      },
      workspaceRoot: "/workspace",
      tools: [],
    });
    try {
      await started;
      process.emit("SIGINT");
      await done;
      assert.equal(seenAbort, true);
    } finally {
      stream.destroy();
    }
  });

  it("/model stays in the REPL when listModels throws", async () => {
    let n = 0;
    const writes: string[] = [];
    const orig = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const { calls } = await run(["/model", "hello"], {
        listModels: async () => {
          n += 1;
          if (n === 1) {
            return ["a"];
          }
          throw new Error("boom");
        },
      });
      assert.match(writes.join(""), /Error: boom/);
      assert.equal(calls.length, 1);
      assert.equal(calls[0][1].model, "a");
    } finally {
      process.stderr.write = orig;
    }
  });
});
