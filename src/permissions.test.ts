import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionAllowlist } from "./permissions.ts";

describe("SessionAllowlist", () => {
  it("empty allowlist allows nothing", () => {
    const list = new SessionAllowlist();
    assert.equal(list.allowsFile("write_file", "a.ts"), false);
    assert.equal(list.allowsCommand(["npm", "test"]), false);
    assert.deepEqual(list.list(), []);
  });

  it("grantFile is per kind and exact path", () => {
    const list = new SessionAllowlist();
    list.grantFile("write_file", "a.ts");
    assert.equal(list.allowsFile("write_file", "a.ts"), true);
    assert.equal(list.allowsFile("str_replace", "a.ts"), false);
    assert.equal(list.allowsFile("delete_file", "a.ts"), false);
    assert.equal(list.allowsFile("write_file", "b.ts"), false);
    assert.equal(list.allowsFile("write_file", "A.ts"), false);
  });

  it("grantCommand is exact argv", () => {
    const list = new SessionAllowlist();
    list.grantCommand(["npm", "test"]);
    assert.equal(list.allowsCommand(["npm", "test"]), true);
    assert.equal(list.allowsCommand(["npm", "test", "-g"]), false);
    assert.equal(list.allowsCommand(["npm", "Test"]), false);
  });

  it("second grant of the same file pair does not duplicate list", () => {
    const list = new SessionAllowlist();
    list.grantFile("write_file", "a.ts");
    list.grantFile("write_file", "a.ts");
    assert.equal(list.list().length, 1);
  });

  it("list is insertion-ordered", () => {
    const list = new SessionAllowlist();
    list.grantFile("write_file", "a.ts");
    list.grantCommand(["npm", "test"]);
    assert.deepEqual(list.list(), [
      { kind: "write_file", path: "a.ts" },
      { kind: "run_command", argv: ["npm", "test"] },
    ]);
  });

  it("list returns a copy of the array and of argv", () => {
    const list = new SessionAllowlist();
    list.grantFile("write_file", "a.ts");
    list.grantCommand(["npm", "test"]);
    const first = list.list();
    const cmd = first.find((grant) => grant.kind === "run_command");
    if (cmd !== undefined && cmd.kind === "run_command") {
      cmd.argv.push("--watch");
    }
    const file = first.find((grant) => grant.kind === "write_file");
    if (file !== undefined && file.kind === "write_file") {
      file.path = "mutated.ts";
    }
    first.pop();
    assert.deepEqual(list.list(), [
      { kind: "write_file", path: "a.ts" },
      { kind: "run_command", argv: ["npm", "test"] },
    ]);
  });

  it("clear drops every grant", () => {
    const list = new SessionAllowlist();
    list.grantFile("write_file", "a.ts");
    list.grantCommand(["npm", "test"]);
    list.clear();
    assert.equal(list.allowsFile("write_file", "a.ts"), false);
    assert.equal(list.allowsCommand(["npm", "test"]), false);
    assert.deepEqual(list.list(), []);
  });

  it("empty path and empty argv are no-ops", () => {
    const list = new SessionAllowlist();
    list.grantFile("write_file", "");
    list.grantCommand([]);
    assert.deepEqual(list.list(), []);
    assert.equal(list.allowsFile("write_file", ""), false);
    assert.equal(list.allowsCommand([]), false);
  });
});
