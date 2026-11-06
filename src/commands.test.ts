import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCommand, type Command } from "./commands.ts";

const cases: [string, Command | null][] = [
  ["", null],
  ["   ", null],
  ["hello", null],
  ["hello world", null],
  ["/help", { type: "help" }],
  ["  /help  ", { type: "help" }],
  ["/clear", { type: "clear" }],
  ["  /clear  ", { type: "clear" }],
  ["/clear extra", { type: "unknown", raw: "/clear" }],
  ["/Clear", { type: "unknown", raw: "/Clear" }],
  ["/model", { type: "model" }],
  ["/model qwen2.5:14b", { type: "model", name: "qwen2.5:14b" }],
  ["/exit", { type: "exit" }],
  ["/Exit", { type: "unknown", raw: "/Exit" }],
  ["/foo", { type: "unknown", raw: "/foo" }],
];

describe("parseCommand", () => {
  for (const [line, expected] of cases) {
    it(JSON.stringify(line), () => {
      assert.deepEqual(parseCommand(line), expected);
    });
  }
});
