import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { Readable, Writable } from "node:stream";
import { describe, it } from "node:test";
import { AGENT_SYSTEM_PROMPT } from "./agent.ts";
import { OllamaError, type ChatMessage } from "./ollama.ts";
import { confirmCommand, confirmWrite, runRepl, type ReplDeps } from "./repl.ts";
import { createTools } from "./tools.ts";

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

function hang(line?: string): Readable {
  const stream = new Readable({ read() {} });
  if (line !== undefined) {
    stream.push(`${line}\n`);
  }
  return stream;
}

async function waitFor(
  text: () => string,
  pattern: string | RegExp | (() => boolean),
  ms = 2000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (typeof pattern === "function") {
      if (pattern()) {
        return;
      }
    } else {
      const snapshot = text();
      if (typeof pattern === "string" ? snapshot.includes(pattern) : pattern.test(snapshot)) {
        return;
      }
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timeout waiting for ${String(pattern)}: ${text()}`);
}

function count(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

function toolThenText(
  calls: Array<{ name: string; arguments: Record<string, unknown> }>,
): ReplDeps["chatStream"] {
  let n = 0;
  return async function* () {
    const i = n;
    n += 1;
    if (i % 2 === 0) {
      const spec = calls[i / 2];
      if (spec !== undefined) {
        yield {
          type: "tool_calls",
          calls: [{ function: spec }],
        };
        return;
      }
    }
    yield { type: "text", text: "done" };
  };
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
    assert.match(stdout, /\/clear/);
    assert.match(stdout, /\/exit/);
    assert.equal(calls.length, 0);
  });

  it("/clear drops history and prints Conversation cleared.", async () => {
    const { stdout, calls } = await run(["hello", "/clear", "again"]);
    assert.match(stdout, /Conversation cleared\./);
    assert.equal(calls.length, 2);
    const second = calls[1][1].messages as ChatMessage[];
    assert.deepEqual(second, [
      { role: "system", content: AGENT_SYSTEM_PROMPT },
      { role: "user", content: "again" },
    ]);
  });

  it("/clear keeps the selected model", async () => {
    const { calls } = await run(["/model b", "/clear", "hello"], {
      listModels: async () => ["a", "b"],
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].model, "b");
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

  it("idle SIGINT still quits", { timeout: 3000 }, async () => {
    const stream = hang();
    const { output, text } = collect();
    const done = runRepl({
      input: stream,
      output,
      host: "http://127.0.0.1:11434",
      listModels: async () => ["m"],
      chatStream: async function* () {
        yield { type: "text", text: "ok" };
      },
      workspaceRoot: "/workspace",
      tools: [],
    });
    try {
      await waitFor(text, "> ");
      process.emit("SIGINT");
      await done;
      assert.equal(text().includes("cancelled"), false);
      assert.equal(text().includes("Error: aborted"), false);
    } finally {
      stream.destroy();
    }
  });

  it("SIGINT during chat cancels the turn and stays in the REPL", { timeout: 3000 }, async () => {
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      release = resolve;
    });
    let seenAbort = false;
    let calls = 0;
    const stream = hang("hello");
    const { output, text } = collect();
    const done = runRepl({
      input: stream,
      output,
      host: "http://127.0.0.1:11434",
      listModels: async () => ["m"],
      chatStream: async function* (_host, args) {
        calls += 1;
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
    const outcome = done.then(
      () => "resolved" as const,
      (err: unknown) => err,
    );
    try {
      await started;
      process.emit("SIGINT");
      await waitFor(text, /cancelled/);
      const raced = await Promise.race([
        outcome,
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
      ]);
      assert.equal(raced, "pending");
      assert.equal(seenAbort, true);
      assert.equal(calls, 1);
      assert.equal(text().includes("Error: aborted"), false);
      await waitFor(text, /cancelled\n> /);
      process.emit("SIGINT");
      await done;
    } finally {
      stream.destroy();
    }
  });

  it("REPL write_file y creates the file", { timeout: 3000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-repl-write-"));
    const stream = new Readable({ read() {} });
    const { output, text } = collect();
    let round = 0;
    const chatStream: ReplDeps["chatStream"] = async function* () {
      round += 1;
      if (round === 1) {
        yield {
          type: "tool_calls",
          calls: [
            {
              function: {
                name: "write_file",
                arguments: { path: "note.txt", content: "hello" },
              },
            },
          ],
        };
        return;
      }
      yield { type: "text", text: "done" };
    };
    const done = runRepl({
      input: stream,
      output,
      host: "http://127.0.0.1:11434",
      listModels: async () => ["m"],
      chatStream,
      workspaceRoot: root,
      tools: createTools(),
    });
    try {
      stream.push("write a note\n");
      await waitFor(text, "[y/N/a]");
      await new Promise((r) => setTimeout(r, 25));
      stream.push("y\n");
      stream.push(null);
      await done;
      assert.equal(
        fs.readFileSync(path.join(root, "note.txt"), "utf8"),
        "hello",
      );
      assert.match(text(), /Allow write to note.txt \(5 bytes\)\? \[y\/N\/a\]/);
      assert.match(text(), /Wrote 5 bytes to note.txt/);
    } finally {
      stream.destroy();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("REPL run_command y runs the process", { timeout: 3000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-repl-run-"));
    const stream = new Readable({ read() {} });
    const { output, text } = collect();
    let round = 0;
    const argv = ["node", "-e", "process.stdout.write('RAN_OK')"];
    const chatStream: ReplDeps["chatStream"] = async function* () {
      round += 1;
      if (round === 1) {
        yield {
          type: "tool_calls",
          calls: [
            {
              function: {
                name: "run_command",
                arguments: { argv },
              },
            },
          ],
        };
        return;
      }
      yield { type: "text", text: "done" };
    };
    const done = runRepl({
      input: stream,
      output,
      host: "http://127.0.0.1:11434",
      listModels: async () => ["m"],
      chatStream,
      workspaceRoot: root,
      tools: createTools(),
    });
    try {
      stream.push("run it\n");
      await waitFor(text, "[y/N/a]");
      await new Promise((r) => setTimeout(r, 25));
      stream.push("y\n");
      await waitFor(text, /exit 0/);
      assert.ok(
        text().includes(`Allow command ${JSON.stringify(argv)}? [y/N/a]`),
      );
      assert.match(text(), /RAN_OK/);
      stream.push("/exit\n");
      await done;
    } finally {
      stream.destroy();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("REPL run_command n does not run", { timeout: 3000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-repl-run-n-"));
    const stream = new Readable({ read() {} });
    const { output, text } = collect();
    let round = 0;
    const argv = ["node", "-e", "process.stdout.write('RAN_OK')"];
    const chatStream: ReplDeps["chatStream"] = async function* () {
      round += 1;
      if (round === 1) {
        yield {
          type: "tool_calls",
          calls: [
            {
              function: {
                name: "run_command",
                arguments: { argv },
              },
            },
          ],
        };
        return;
      }
      yield { type: "text", text: "done" };
    };
    const done = runRepl({
      input: stream,
      output,
      host: "http://127.0.0.1:11434",
      listModels: async () => ["m"],
      chatStream,
      workspaceRoot: root,
      tools: createTools(),
    });
    try {
      stream.push("run it\n");
      await waitFor(text, "[y/N/a]");
      await new Promise((r) => setTimeout(r, 25));
      stream.push("n\n");
      await waitFor(text, /denied/);
      assert.equal(text().includes("exit 0"), false);
      stream.push("/exit\n");
      await done;
    } finally {
      stream.destroy();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("REPL str_replace y edits the file", { timeout: 3000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-repl-repl-"));
    fs.writeFileSync(path.join(root, "a.ts"), "const x = 1;\n");
    const stream = new Readable({ read() {} });
    const { output, text } = collect();
    let round = 0;
    const chatStream: ReplDeps["chatStream"] = async function* () {
      round += 1;
      if (round === 1) {
        yield {
          type: "tool_calls",
          calls: [
            {
              function: {
                name: "str_replace",
                arguments: {
                  path: "a.ts",
                  old_string: "const x = 1;",
                  new_string: "const x = 2;",
                },
              },
            },
          ],
        };
        return;
      }
      yield { type: "text", text: "done" };
    };
    const done = runRepl({
      input: stream,
      output,
      host: "http://127.0.0.1:11434",
      listModels: async () => ["m"],
      chatStream,
      workspaceRoot: root,
      tools: createTools(),
    });
    try {
      stream.push("edit it\n");
      await waitFor(text, "Allow replace in ");
      await new Promise((r) => setTimeout(r, 25));
      stream.push("y\n");
      stream.push("/exit\n");
      await done;
      assert.match(text(), /Allow replace in a.ts\? \[y\/N\/a\]/);
      assert.match(text(), /Replaced in a.ts/);
      assert.equal(fs.readFileSync(path.join(root, "a.ts"), "utf8"), "const x = 2;\n");
    } finally {
      stream.destroy();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("REPL str_replace n leaves the file unchanged", { timeout: 3000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-repl-repl-n-"));
    fs.writeFileSync(path.join(root, "a.ts"), "const x = 1;\n");
    const stream = new Readable({ read() {} });
    const { output, text } = collect();
    let round = 0;
    const chatStream: ReplDeps["chatStream"] = async function* () {
      round += 1;
      if (round === 1) {
        yield {
          type: "tool_calls",
          calls: [
            {
              function: {
                name: "str_replace",
                arguments: {
                  path: "a.ts",
                  old_string: "const x = 1;",
                  new_string: "const x = 2;",
                },
              },
            },
          ],
        };
        return;
      }
      yield { type: "text", text: "done" };
    };
    const done = runRepl({
      input: stream,
      output,
      host: "http://127.0.0.1:11434",
      listModels: async () => ["m"],
      chatStream,
      workspaceRoot: root,
      tools: createTools(),
    });
    try {
      stream.push("edit it\n");
      await waitFor(text, "Allow replace in ");
      await new Promise((r) => setTimeout(r, 25));
      stream.push("n\n");
      await waitFor(text, /denied/);
      stream.push("/exit\n");
      await done;
      assert.match(text(), /denied/);
      assert.equal(fs.readFileSync(path.join(root, "a.ts"), "utf8"), "const x = 1;\n");
    } finally {
      stream.destroy();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("REPL delete_file y unlinks the file", { timeout: 3000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-repl-del-"));
    fs.writeFileSync(path.join(root, "a.txt"), "x");
    const stream = new Readable({ read() {} });
    const { output, text } = collect();
    let round = 0;
    const chatStream: ReplDeps["chatStream"] = async function* () {
      round += 1;
      if (round === 1) {
        yield {
          type: "tool_calls",
          calls: [
            {
              function: {
                name: "delete_file",
                arguments: { path: "a.txt" },
              },
            },
          ],
        };
        return;
      }
      yield { type: "text", text: "done" };
    };
    const done = runRepl({
      input: stream,
      output,
      host: "http://127.0.0.1:11434",
      listModels: async () => ["m"],
      chatStream,
      workspaceRoot: root,
      tools: createTools(),
    });
    try {
      stream.push("delete it\n");
      await waitFor(text, "Allow delete ");
      await new Promise((r) => setTimeout(r, 25));
      stream.push("y\n");
      stream.push("/exit\n");
      await done;
      assert.match(text(), /Allow delete a.txt\? \[y\/N\/a\]/);
      assert.match(text(), /Deleted a.txt/);
      assert.equal(fs.existsSync(path.join(root, "a.txt")), false);
    } finally {
      stream.destroy();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("REPL delete_file n leaves the file", { timeout: 3000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-repl-del-n-"));
    fs.writeFileSync(path.join(root, "a.txt"), "x");
    const stream = new Readable({ read() {} });
    const { output, text } = collect();
    let round = 0;
    const chatStream: ReplDeps["chatStream"] = async function* () {
      round += 1;
      if (round === 1) {
        yield {
          type: "tool_calls",
          calls: [
            {
              function: {
                name: "delete_file",
                arguments: { path: "a.txt" },
              },
            },
          ],
        };
        return;
      }
      yield { type: "text", text: "done" };
    };
    const done = runRepl({
      input: stream,
      output,
      host: "http://127.0.0.1:11434",
      listModels: async () => ["m"],
      chatStream,
      workspaceRoot: root,
      tools: createTools(),
    });
    try {
      stream.push("delete it\n");
      await waitFor(text, "Allow delete ");
      await new Promise((r) => setTimeout(r, 25));
      stream.push("n\n");
      await waitFor(text, /denied/);
      stream.push("/exit\n");
      await done;
      assert.equal(fs.existsSync(path.join(root, "a.txt")), true);
    } finally {
      stream.destroy();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("y allows write once and prompts again", { timeout: 3000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-repl-y-once-"));
    const stream = new Readable({ read() {} });
    const { output, text } = collect();
    const done = runRepl({
      input: stream,
      output,
      host: "http://127.0.0.1:11434",
      listModels: async () => ["m"],
      chatStream: toolThenText([
        { name: "write_file", arguments: { path: "a.txt", content: "one" } },
        { name: "write_file", arguments: { path: "a.txt", content: "two" } },
      ]),
      workspaceRoot: root,
      tools: createTools(),
    });
    try {
      stream.push("first\n");
      await waitFor(text, "Allow write to a.txt");
      await new Promise((r) => setTimeout(r, 25));
      stream.push("y\n");
      await waitFor(text, /Wrote /);
      stream.push("second\n");
      await waitFor(text, () => count(text(), "Allow write to a.txt") >= 2);
      await new Promise((r) => setTimeout(r, 25));
      stream.push("y\n");
      stream.push("/exit\n");
      await done;
      assert.equal(count(text(), "Allow write to a.txt"), 2);
      assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "two");
    } finally {
      stream.destroy();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("a skips the next write on the same path", { timeout: 3000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-repl-a-skip-"));
    const stream = new Readable({ read() {} });
    const { output, text } = collect();
    const done = runRepl({
      input: stream,
      output,
      host: "http://127.0.0.1:11434",
      listModels: async () => ["m"],
      chatStream: toolThenText([
        { name: "write_file", arguments: { path: "a.txt", content: "one" } },
        { name: "write_file", arguments: { path: "a.txt", content: "two" } },
      ]),
      workspaceRoot: root,
      tools: createTools(),
    });
    try {
      stream.push("first\n");
      await waitFor(text, "Allow write to a.txt");
      await new Promise((r) => setTimeout(r, 25));
      stream.push("a\n");
      await waitFor(text, /Wrote /);
      stream.push("second\n");
      await waitFor(text, () => count(text(), "Wrote ") >= 2);
      stream.push("/exit\n");
      await done;
      assert.equal(count(text(), "Allow write to a.txt"), 1);
      assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "two");
    } finally {
      stream.destroy();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("a on a.txt still prompts write to b.txt", { timeout: 3000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-repl-a-other-path-"));
    const stream = new Readable({ read() {} });
    const { output, text } = collect();
    const done = runRepl({
      input: stream,
      output,
      host: "http://127.0.0.1:11434",
      listModels: async () => ["m"],
      chatStream: toolThenText([
        { name: "write_file", arguments: { path: "a.txt", content: "a" } },
        { name: "write_file", arguments: { path: "b.txt", content: "b" } },
      ]),
      workspaceRoot: root,
      tools: createTools(),
    });
    try {
      stream.push("first\n");
      await waitFor(text, "Allow write to a.txt");
      await new Promise((r) => setTimeout(r, 25));
      stream.push("a\n");
      await waitFor(text, /Wrote /);
      stream.push("second\n");
      await waitFor(text, "Allow write to b.txt");
      await new Promise((r) => setTimeout(r, 25));
      stream.push("y\n");
      stream.push("/exit\n");
      await done;
      assert.match(text(), /Allow write to b.txt/);
    } finally {
      stream.destroy();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("a on write_file does not cover delete_file on the same path", { timeout: 3000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-repl-a-other-tool-"));
    const stream = new Readable({ read() {} });
    const { output, text } = collect();
    const done = runRepl({
      input: stream,
      output,
      host: "http://127.0.0.1:11434",
      listModels: async () => ["m"],
      chatStream: toolThenText([
        { name: "write_file", arguments: { path: "a.txt", content: "keep" } },
        { name: "delete_file", arguments: { path: "a.txt" } },
      ]),
      workspaceRoot: root,
      tools: createTools(),
    });
    try {
      stream.push("write\n");
      await waitFor(text, "Allow write to a.txt");
      await new Promise((r) => setTimeout(r, 25));
      stream.push("a\n");
      await waitFor(text, /Wrote /);
      stream.push("delete\n");
      await waitFor(text, "Allow delete a.txt");
      await new Promise((r) => setTimeout(r, 25));
      stream.push("n\n");
      stream.push("/exit\n");
      await done;
      assert.match(text(), /Allow delete a.txt/);
      assert.equal(fs.existsSync(path.join(root, "a.txt")), true);
    } finally {
      stream.destroy();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("a on a command argv skips only that exact argv", { timeout: 5000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-repl-a-argv-"));
    const stream = new Readable({ read() {} });
    const { output, text } = collect();
    const same = ["node", "-e", "process.stdout.write('SAME')"];
    const other = ["node", "-e", "process.stdout.write('OTHER')"];
    const done = runRepl({
      input: stream,
      output,
      host: "http://127.0.0.1:11434",
      listModels: async () => ["m"],
      chatStream: toolThenText([
        { name: "run_command", arguments: { argv: same } },
        { name: "run_command", arguments: { argv: same } },
        { name: "run_command", arguments: { argv: other } },
      ]),
      workspaceRoot: root,
      tools: createTools(),
    });
    try {
      stream.push("first\n");
      await waitFor(text, "Allow command ");
      await new Promise((r) => setTimeout(r, 25));
      stream.push("a\n");
      await waitFor(text, /SAME/);
      stream.push("again\n");
      await waitFor(text, () => count(text(), "SAME") >= 2);
      assert.equal(count(text(), "Allow command "), 1);
      stream.push("other\n");
      await waitFor(text, () => count(text(), "Allow command ") >= 2);
      await new Promise((r) => setTimeout(r, 25));
      stream.push("y\n");
      await waitFor(text, /OTHER/);
      stream.push("/exit\n");
      await done;
    } finally {
      stream.destroy();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uppercase A denies and does not grant", { timeout: 3000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-repl-A-deny-"));
    const stream = new Readable({ read() {} });
    const { output, text } = collect();
    const done = runRepl({
      input: stream,
      output,
      host: "http://127.0.0.1:11434",
      listModels: async () => ["m"],
      chatStream: toolThenText([
        { name: "write_file", arguments: { path: "a.txt", content: "x" } },
        { name: "write_file", arguments: { path: "a.txt", content: "y" } },
      ]),
      workspaceRoot: root,
      tools: createTools(),
    });
    try {
      stream.push("first\n");
      await waitFor(text, "Allow write to a.txt");
      await new Promise((r) => setTimeout(r, 25));
      stream.push("A\n");
      await waitFor(text, /denied/);
      stream.push("second\n");
      await waitFor(text, () => count(text(), "Allow write to a.txt") >= 2);
      await new Promise((r) => setTimeout(r, 25));
      stream.push("n\n");
      stream.push("/exit\n");
      await done;
      assert.equal(fs.existsSync(path.join(root, "a.txt")), false);
    } finally {
      stream.destroy();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uppercase Y denies and does not grant", { timeout: 3000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-repl-Y-deny-"));
    const stream = new Readable({ read() {} });
    const { output, text } = collect();
    const done = runRepl({
      input: stream,
      output,
      host: "http://127.0.0.1:11434",
      listModels: async () => ["m"],
      chatStream: toolThenText([
        { name: "write_file", arguments: { path: "a.txt", content: "x" } },
        { name: "write_file", arguments: { path: "a.txt", content: "y" } },
      ]),
      workspaceRoot: root,
      tools: createTools(),
    });
    try {
      stream.push("first\n");
      await waitFor(text, "Allow write to a.txt");
      await new Promise((r) => setTimeout(r, 25));
      stream.push("Y\n");
      await waitFor(text, /denied/);
      stream.push("second\n");
      await waitFor(text, () => count(text(), "Allow write to a.txt") >= 2);
      await new Promise((r) => setTimeout(r, 25));
      stream.push("n\n");
      stream.push("/exit\n");
      await done;
      assert.equal(fs.existsSync(path.join(root, "a.txt")), false);
    } finally {
      stream.destroy();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("abort during prompt does not grant", { timeout: 3000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-repl-abort-grant-"));
    const stream = hang("write a note");
    const { output, text } = collect();
    const done = runRepl({
      input: stream,
      output,
      host: "http://127.0.0.1:11434",
      listModels: async () => ["m"],
      chatStream: (() => {
        let n = 0;
        return async function* () {
          n += 1;
          if (n === 1 || n === 2) {
            yield {
              type: "tool_calls",
              calls: [
                {
                  function: {
                    name: "write_file",
                    arguments: { path: "a.txt", content: "x" },
                  },
                },
              ],
            };
            return;
          }
          yield { type: "text", text: "done" };
        };
      })(),
      workspaceRoot: root,
      tools: createTools(),
    });
    try {
      await waitFor(text, "Allow write to a.txt");
      process.emit("SIGINT");
      await waitFor(text, /cancelled/);
      assert.equal(text().includes("denied"), false);
      stream.push("again\n");
      await waitFor(text, () => count(text(), "Allow write to a.txt") >= 2);
      await new Promise((r) => setTimeout(r, 25));
      stream.push("n\n");
      stream.push("/exit\n");
      await done;
      assert.equal(fs.existsSync(path.join(root, "a.txt")), false);
    } finally {
      stream.destroy();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("/clear keeps session grants", { timeout: 3000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-repl-clear-grant-"));
    const stream = new Readable({ read() {} });
    const { output, text } = collect();
    const argv = ["node", "-e", "process.stdout.write('RAN')"];
    const done = runRepl({
      input: stream,
      output,
      host: "http://127.0.0.1:11434",
      listModels: async () => ["m"],
      chatStream: toolThenText([
        { name: "run_command", arguments: { argv } },
        { name: "run_command", arguments: { argv } },
      ]),
      workspaceRoot: root,
      tools: createTools(),
    });
    try {
      stream.push("run\n");
      await waitFor(text, "Allow command ");
      await new Promise((r) => setTimeout(r, 25));
      stream.push("a\n");
      await waitFor(text, /RAN/);
      stream.push("/clear\n");
      await waitFor(text, "Conversation cleared.");
      stream.push("run again\n");
      await waitFor(text, () => count(text(), "RAN") >= 2);
      stream.push("/exit\n");
      await done;
      assert.equal(count(text(), "Allow command "), 1);
    } finally {
      stream.destroy();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("confirmWrite allows only trimmed lowercase y", async () => {
    async function ask(answer: string): Promise<{ allowed: boolean; stdout: string }> {
      const { output, text } = collect();
      const rl = readline.createInterface({
        input: input([answer]),
        output,
      });
      try {
        const allowed = await confirmWrite(rl, output, {
          name: "write_file",
          path: "a.txt",
          preview: "hello",
          bytes: 5,
        });
        return { allowed, stdout: text() };
      } finally {
        rl.close();
      }
    }

    const yes = await ask("y");
    assert.equal(yes.allowed, true);
    assert.match(yes.stdout, /Allow write to a.txt \(5 bytes\)\? \[y\/N\/a\]/);
    assert.match(yes.stdout, /^ {2}hello$/m);
    assert.equal(yes.stdout.includes("denied"), false);

    const paddedYes = await ask(" y ");
    assert.equal(paddedYes.allowed, true);

    const padded = await ask(" Y ");
    assert.equal(padded.allowed, false);
    assert.match(padded.stdout, /denied/);

    const no = await ask("n");
    assert.equal(no.allowed, false);
    assert.match(no.stdout, /denied/);

    const word = await ask("yes");
    assert.equal(word.allowed, false);
    assert.match(word.stdout, /denied/);

    const empty = await ask("");
    assert.equal(empty.allowed, false);
    assert.match(empty.stdout, /denied/);
  });

  it("confirmCommand allows only trimmed lowercase y", async () => {
    async function ask(answer: string): Promise<{ allowed: boolean; stdout: string }> {
      const { output, text } = collect();
      const rl = readline.createInterface({
        input: input([answer]),
        output,
      });
      try {
        const allowed = await confirmCommand(rl, output, {
          name: "run_command",
          preview: JSON.stringify(["npm", "test"]),
          argv: ["npm", "test"],
        });
        return { allowed, stdout: text() };
      } finally {
        rl.close();
      }
    }

    const yes = await ask("y");
    assert.equal(yes.allowed, true);
    assert.match(yes.stdout, /Allow command \["npm","test"\]\? \[y\/N\/a\]/);
    assert.equal(yes.stdout.includes("denied"), false);

    const no = await ask("n");
    assert.equal(no.allowed, false);
    assert.match(no.stdout, /denied/);
  });

  it("confirmWrite already-aborted skips the prompt", async () => {
    const { output, text } = collect();
    const rl = readline.createInterface({
      input: input([]),
      output,
    });
    try {
      const allowed = await confirmWrite(
        rl,
        output,
        {
          name: "write_file",
          path: "a.txt",
          preview: "hello",
          bytes: 5,
        },
        AbortSignal.abort(),
      );
      assert.equal(allowed, false);
      assert.equal(text(), "");
    } finally {
      rl.close();
    }
  });

  it("confirmWrite abort resolves false without denied", async () => {
    const { output, text } = collect();
    const stream = new Readable({ read() {} });
    const rl = readline.createInterface({
      input: stream,
      output,
    });
    const controller = new AbortController();
    try {
      const pending = confirmWrite(
        rl,
        output,
        {
          name: "write_file",
          path: "a.txt",
          preview: "hello",
          bytes: 5,
        },
        controller.signal,
      );
      controller.abort();
      assert.equal(await pending, false);
      assert.equal(text().includes("denied"), false);
    } finally {
      rl.close();
      stream.destroy();
    }
  });

  it("SIGINT during write confirm denies and stays", { timeout: 3000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-repl-cancel-write-"));
    const stream = hang("write a note");
    const { output, text } = collect();
    let rounds = 0;
    const done = runRepl({
      input: stream,
      output,
      host: "http://127.0.0.1:11434",
      listModels: async () => ["m"],
      chatStream: async function* () {
        rounds += 1;
        yield {
          type: "tool_calls",
          calls: [
            {
              function: {
                name: "write_file",
                arguments: { path: "note.txt", content: "hello" },
              },
            },
          ],
        };
      },
      workspaceRoot: root,
      tools: createTools(),
    });
    const outcome = done.then(
      () => "resolved" as const,
      (err: unknown) => err,
    );
    try {
      await waitFor(text, "[y/N/a]");
      process.emit("SIGINT");
      await waitFor(text, /cancelled/);
      const raced = await Promise.race([
        outcome,
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
      ]);
      assert.equal(raced, "pending");
      assert.equal(fs.existsSync(path.join(root, "note.txt")), false);
      assert.equal(text().includes("Error: aborted"), false);
      assert.equal(rounds, 1);
      stream.push("/exit\n");
      await done;
    } finally {
      stream.destroy();
      fs.rmSync(root, { recursive: true, force: true });
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
