import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { describe, it } from "node:test";
import {
  AGENT_SYSTEM_PROMPT,
  MAX_TOOL_ROUNDS,
  runTurn,
  type RunTurnDeps,
} from "./agent.ts";
import type { ChatEvent, ChatMessage } from "./ollama.ts";
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

async function withStderr(fn: () => Promise<void>): Promise<string> {
  const writes: string[] = [];
  const orig = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
    return writes.join("");
  } finally {
    process.stderr.write = orig;
  }
}

async function withTempWorkspace(
  fn: (root: string) => Promise<void>,
): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-agent-"));
  try {
    await fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

type ChatCall = Parameters<RunTurnDeps["chatStream"]>;

function scriptedChat(
  replies: ChatEvent[][],
): {
  chatStream: RunTurnDeps["chatStream"];
  calls: ChatCall[];
} {
  const calls: ChatCall[] = [];
  const chatStream: RunTurnDeps["chatStream"] = async function* (host, args) {
    const index = calls.length;
    calls.push([host, { ...args, messages: [...args.messages] }]);
    const events = replies[index] ?? [];
    for (const event of events) {
      yield event;
    }
  };
  return { chatStream, calls };
}

function baseDeps(
  overrides: Partial<RunTurnDeps> & Pick<RunTurnDeps, "messages" | "chatStream" | "output">,
): RunTurnDeps {
  return {
    host: "http://127.0.0.1:11434",
    model: "m",
    tools: [],
    workspaceRoot: "/workspace",
    ...overrides,
  };
}

describe("runTurn", () => {
  it("plain text: writes hi, pushes assistant, one chat with tools", async () => {
    const { output, text } = collect();
    const messages: ChatMessage[] = [{ role: "user", content: "hello" }];
    const { chatStream, calls } = scriptedChat([
      [{ type: "text", text: "hi" }],
    ]);
    await runTurn(
      baseDeps({
        messages,
        tools: createTools(),
        chatStream,
        output,
      }),
    );
    assert.match(text(), /hi/);
    assert.deepEqual(messages.at(-1), { role: "assistant", content: "hi" });
    assert.equal(calls.length, 1);
    const tools = calls[0][1].tools;
    assert.ok(tools);
    assert.deepEqual(
      tools.map((tool) => tool.function.name),
      ["list_dir", "read_file", "write_file"],
    );
  });

  it("one tool round: list_dir against a real workspace, then text", async () => {
    await withTempWorkspace(async (root) => {
      fs.mkdirSync(path.join(root, "src"));
      fs.writeFileSync(path.join(root, "src", "a.ts"), "x");
      const { output, text } = collect();
      const messages: ChatMessage[] = [{ role: "user", content: "list src" }];
      const { chatStream, calls } = scriptedChat([
        [
          {
            type: "tool_calls",
            calls: [
              { function: { name: "list_dir", arguments: { path: "src" } } },
            ],
          },
        ],
        [{ type: "text", text: "ok" }],
      ]);
      await runTurn(
        baseDeps({
          messages,
          tools: createTools(),
          chatStream,
          output,
          workspaceRoot: root,
        }),
      );
      const stdout = text();
      assert.match(stdout, /tool: list_dir \{"path":"src"\}/);
      assert.match(stdout, /ok/);
      const assistantWithCalls = messages.find(
        (message) => message.role === "assistant" && message.tool_calls,
      );
      assert.deepEqual(assistantWithCalls?.tool_calls, [
        { function: { name: "list_dir", arguments: { path: "src" } } },
      ]);
      const toolMsg = messages.find((message) => message.role === "tool");
      assert.ok(toolMsg);
      assert.equal(toolMsg.tool_name, "list_dir");
      const listing = JSON.parse(toolMsg.content) as {
        path: string;
        entries: { name: string }[];
      };
      assert.equal(listing.path, "src");
      assert.ok(listing.entries.some((entry) => entry.name === "a.ts"));
      assert.equal(calls.length, 2);
      const second = calls[1][1].messages;
      assert.ok(second.some((message) => message.role === "tool"));
    });
  });

  it("two tool calls in one round execute in order", async () => {
    await withTempWorkspace(async (root) => {
      fs.mkdirSync(path.join(root, "src"));
      fs.writeFileSync(path.join(root, "a.txt"), "hello");
      const { output, text } = collect();
      const messages: ChatMessage[] = [{ role: "user", content: "look" }];
      const { chatStream, calls } = scriptedChat([
        [
          {
            type: "tool_calls",
            calls: [
              { function: { name: "list_dir", arguments: { path: "src" } } },
              { function: { name: "read_file", arguments: { path: "a.txt" } } },
            ],
          },
        ],
        [{ type: "text", text: "ok" }],
      ]);
      await runTurn(
        baseDeps({
          messages,
          tools: createTools(),
          chatStream,
          output,
          workspaceRoot: root,
        }),
      );
      assert.match(
        text(),
        /tool: list_dir \{"path":"src"\}\ntool: read_file \{"path":"a.txt"\}/,
      );
      const toolMsgs = messages.filter((message) => message.role === "tool");
      assert.deepEqual(
        toolMsgs.map((message) => message.tool_name),
        ["list_dir", "read_file"],
      );
      assert.equal(toolMsgs[1]?.content, "hello");
      assert.equal(calls.length, 2);
    });
  });

  it("unknown tool: Error: unknown tool, then a second chat", async () => {
    const { output } = collect();
    const messages: ChatMessage[] = [{ role: "user", content: "go" }];
    const { chatStream, calls } = scriptedChat([
      [
        {
          type: "tool_calls",
          calls: [{ function: { name: "boom", arguments: {} } }],
        },
      ],
      [{ type: "text", text: "ok" }],
    ]);
    await runTurn(baseDeps({ messages, chatStream, output }));
    const toolMsg = messages.find((message) => message.role === "tool");
    assert.equal(toolMsg?.content, "Error: unknown tool: boom");
    assert.equal(calls.length, 2);
  });

  it("round cap: 8 list_dir chats then stop, no 9th", async () => {
    const { output } = collect();
    const messages: ChatMessage[] = [{ role: "user", content: "loop" }];
    const calls: ChatCall[] = [];
    const chatStream: RunTurnDeps["chatStream"] = async function* (host, args) {
      calls.push([host, { ...args, messages: [...args.messages] }]);
      yield {
        type: "tool_calls",
        calls: [{ function: { name: "list_dir", arguments: { path: "." } } }],
      };
    };
    const stderr = await withStderr(() =>
      runTurn(baseDeps({ messages, chatStream, output })),
    );
    assert.equal(calls.length, MAX_TOOL_ROUNDS);
    assert.equal(
      messages.filter((message) => message.role === "tool").length,
      MAX_TOOL_ROUNDS,
    );
    assert.match(stderr, /Stopped after 8 tool rounds/);
  });

  it("system prompt is prepended once across two runTurn calls", async () => {
    const { output } = collect();
    const messages: ChatMessage[] = [{ role: "user", content: "hello" }];
    const { chatStream } = scriptedChat([
      [{ type: "text", text: "a" }],
      [{ type: "text", text: "b" }],
    ]);
    const deps = baseDeps({ messages, chatStream, output });
    await runTurn(deps);
    assert.deepEqual(messages[0], {
      role: "system",
      content: AGENT_SYSTEM_PROMPT,
    });
    await runTurn(deps);
    assert.equal(
      messages.filter((message) => message.role === "system").length,
      1,
    );
    assert.equal(messages[0].content, AGENT_SYSTEM_PROMPT);
  });

  it("already-aborted signal rejects with AbortError and no assistant", async () => {
    const { output } = collect();
    const messages: ChatMessage[] = [{ role: "user", content: "hello" }];
    const chatStream: RunTurnDeps["chatStream"] = async function* () {
      yield { type: "text", text: "nope" };
    };
    await assert.rejects(
      () =>
        runTurn(
          baseDeps({
            messages,
            chatStream,
            output,
            signal: AbortSignal.abort(),
          }),
        ),
      (err: unknown) => {
        assert.equal((err as Error).name, "AbortError");
        return true;
      },
    );
    assert.equal(
      messages.filter((message) => message.role === "assistant").length,
      0,
    );
  });

  it("abort during execute stops remaining tools and skips the next chat", async () => {
    const { output } = collect();
    const messages: ChatMessage[] = [{ role: "user", content: "go" }];
    const controller = new AbortController();
    let secondExecuted = false;
    let chats = 0;
    const chatStream: RunTurnDeps["chatStream"] = async function* () {
      chats += 1;
      yield {
        type: "tool_calls",
        calls: [
          { function: { name: "first", arguments: {} } },
          { function: { name: "second", arguments: {} } },
        ],
      };
    };
    const tools: RunTurnDeps["tools"] = [
      {
        name: "first",
        description: "first",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          controller.abort();
          return "first-done";
        },
      },
      {
        name: "second",
        description: "second",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          secondExecuted = true;
          return "second-done";
        },
      },
    ];
    await assert.rejects(
      () =>
        runTurn(
          baseDeps({
            messages,
            tools,
            chatStream,
            output,
            signal: controller.signal,
          }),
        ),
      (err: unknown) => {
        assert.equal((err as Error).name, "AbortError");
        return true;
      },
    );
    assert.equal(secondExecuted, false);
    assert.equal(chats, 1);
    assert.equal(
      messages.filter((message) => message.tool_name === "second").length,
      0,
    );
  });

  it("write_file confirm true writes the file", async () => {
    await withTempWorkspace(async (root) => {
      const { output, text } = collect();
      const messages: ChatMessage[] = [{ role: "user", content: "write" }];
      const { chatStream } = scriptedChat([
        [
          {
            type: "tool_calls",
            calls: [
              {
                function: {
                  name: "write_file",
                  arguments: { path: "a.txt", content: "hello" },
                },
              },
            ],
          },
        ],
        [{ type: "text", text: "ok" }],
      ]);
      await runTurn(
        baseDeps({
          messages,
          tools: createTools(),
          chatStream,
          output,
          workspaceRoot: root,
          confirm: async () => true,
        }),
      );
      assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "hello");
      assert.match(text(), /Wrote 5 bytes to a.txt/);
      const toolMsg = messages.find((message) => message.role === "tool");
      assert.equal(toolMsg?.content, "Wrote 5 bytes to a.txt");
    });
  });

  it("write_file confirm false leaves the file unchanged", async () => {
    await withTempWorkspace(async (root) => {
      fs.writeFileSync(path.join(root, "a.txt"), "keep");
      const { output, text } = collect();
      const messages: ChatMessage[] = [{ role: "user", content: "write" }];
      const { chatStream } = scriptedChat([
        [
          {
            type: "tool_calls",
            calls: [
              {
                function: {
                  name: "write_file",
                  arguments: { path: "a.txt", content: "nope" },
                },
              },
            ],
          },
        ],
        [{ type: "text", text: "ok" }],
      ]);
      await runTurn(
        baseDeps({
          messages,
          tools: createTools(),
          chatStream,
          output,
          workspaceRoot: root,
          confirm: async () => false,
        }),
      );
      assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "keep");
      assert.equal(
        messages.find((message) => message.role === "tool")?.content,
        "User denied write to a.txt.",
      );
      assert.equal(text().includes("denied"), false);
    });
  });

  it("write_file tool line truncates content longer than 80 characters", async () => {
    await withTempWorkspace(async (root) => {
      const { output, text } = collect();
      const content = "x".repeat(81);
      const n = Buffer.byteLength(content, "utf8");
      const messages: ChatMessage[] = [{ role: "user", content: "write" }];
      const { chatStream } = scriptedChat([
        [
          {
            type: "tool_calls",
            calls: [
              {
                function: {
                  name: "write_file",
                  arguments: { path: "big.txt", content },
                },
              },
            ],
          },
        ],
        [{ type: "text", text: "ok" }],
      ]);
      await runTurn(
        baseDeps({
          messages,
          tools: createTools(),
          chatStream,
          output,
          workspaceRoot: root,
          confirm: async () => true,
        }),
      );
      const stdout = text();
      assert.match(
        stdout,
        new RegExp(
          `tool: write_file \\{"path":"big.txt","content":"<truncated ${n} bytes>"\\}`,
        ),
      );
      assert.equal(stdout.includes(content), false);
      assert.equal(fs.readFileSync(path.join(root, "big.txt"), "utf8"), content);
    });
  });

  it("empty tools omits tools on the chatStream request", async () => {
    const { output } = collect();
    const messages: ChatMessage[] = [{ role: "user", content: "hello" }];
    const { chatStream, calls } = scriptedChat([
      [{ type: "text", text: "hi" }],
    ]);
    await runTurn(baseDeps({ messages, chatStream, output }));
    assert.equal(calls[0][1].tools, undefined);
  });
});
