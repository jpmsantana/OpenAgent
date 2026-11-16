import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRegexTester } from "./regex.ts";

describe("createRegexTester", () => {
  it("matches foo and rejects bar", () => {
    const tester = createRegexTester("foo", "");
    assert.equal(tester("foo"), true);
    assert.equal(tester("bar"), false);
  });

  it("flag i matches Foo", () => {
    const tester = createRegexTester("foo", "i");
    assert.equal(tester("Foo"), true);
  });

  it("ReDoS pattern times out", () => {
    const tester = createRegexTester("(a+)+$", "");
    const started = Date.now();
    assert.equal(tester("a".repeat(30) + "b"), "timeout");
    assert.ok(Date.now() - started < 1000);
  });
});
