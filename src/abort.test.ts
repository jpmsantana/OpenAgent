import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isAbortError,
  isAbortOrTimeoutError,
  rethrowIfAbort,
} from "./abort.ts";

describe("isAbortError", () => {
  it("is true for AbortError name on a plain object and an Error", () => {
    assert.equal(isAbortError({ name: "AbortError" }), true);
    const err = new Error("aborted");
    err.name = "AbortError";
    assert.equal(isAbortError(err), true);
  });

  it("is false for TimeoutError, Error, null, and a string", () => {
    assert.equal(isAbortError({ name: "TimeoutError" }), false);
    assert.equal(isAbortError({ name: "Error" }), false);
    assert.equal(isAbortError(null), false);
    assert.equal(isAbortError("AbortError"), false);
  });
});

describe("isAbortOrTimeoutError", () => {
  it("is true for AbortError and TimeoutError", () => {
    assert.equal(isAbortOrTimeoutError({ name: "AbortError" }), true);
    assert.equal(isAbortOrTimeoutError({ name: "TimeoutError" }), true);
  });

  it("is false for a plain Error", () => {
    assert.equal(isAbortOrTimeoutError(new Error("nope")), false);
  });
});

describe("rethrowIfAbort", () => {
  it("rethrows the same AbortError object", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    assert.throws(() => rethrowIfAbort(err), (caught: unknown) => caught === err);
  });

  it("throws AbortError via throwIfAborted when the signal is aborted", () => {
    const signal = AbortSignal.abort();
    assert.throws(
      () => rethrowIfAbort(new Error("other"), signal),
      (caught: unknown) => {
        assert.equal((caught as Error).name, "AbortError");
        return true;
      },
    );
  });
});
