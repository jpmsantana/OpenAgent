import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { describe, it } from "node:test";
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
    yield "ok";
  };
  await runRepl({
    input: input(lines),
    output,
    host: "http://127.0.0.1:11434",
    listModels: async () => ["m"],
    chatStream,
    ...overrides,
  });
  return { stdout: text(), calls };
}

describe("runRepl", () => {
  it("streams chat chunks to stdout", async () => {
    const { stdout } = await run(["hello"]);
    assert.match(stdout, /OpenAgent {2}\(ollama \/ m\)/);
    assert.match(stdout, /ok/);
  });

  it("second turn includes prior user and assistant messages", async () => {
    const { calls } = await run(["hello", "again"]);
    assert.equal(calls.length, 2);
    const second = calls[1][1].messages as ChatMessage[];
    assert.deepEqual(second, [
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
});
