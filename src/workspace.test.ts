import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { resolveWorkspacePath, WorkspacePathError } from "./workspace.ts";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oa-ws-"));
}

function withRoot(fn: (root: string) => void): void {
  const root = tmp();
  try {
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function withNeighbor(fn: (root: string, neighbor: string) => void): void {
  const base = tmp();
  const root = path.join(base, "ws");
  fs.mkdirSync(root);
  try {
    fn(root, base);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

describe("resolveWorkspacePath", () => {
  it(`"." → the realpath of the root`, () => {
    withRoot((root) => {
      assert.equal(resolveWorkspacePath(root, "."), fs.realpathSync(root));
    });
  });

  it(`"src/a.txt" under a created tree → that file`, () => {
    withRoot((root) => {
      const file = path.join(root, "src", "a.txt");
      fs.mkdirSync(path.dirname(file));
      fs.writeFileSync(file, "hi");
      assert.equal(resolveWorkspacePath(root, "src/a.txt"), fs.realpathSync(file));
    });
  });

  it(`"../outside.txt" next to the root throws`, () => {
    withNeighbor((root, base) => {
      const outside = path.join(base, "outside.txt");
      fs.writeFileSync(outside, "nope");
      assert.throws(
        () => resolveWorkspacePath(root, "../outside.txt"),
        (err: unknown) => {
          assert.ok(err instanceof WorkspacePathError);
          assert.match(err.message, /path escapes workspace/);
          return true;
        },
      );
    });
  });

  it("absolute path to a file outside the root throws", () => {
    withNeighbor((root, base) => {
      const outside = path.join(base, "outside.txt");
      fs.writeFileSync(outside, "nope");
      assert.throws(
        () => resolveWorkspacePath(root, fs.realpathSync(outside)),
        /path escapes workspace/,
      );
    });
  });

  it("absolute path to a file inside the root is allowed", () => {
    withRoot((root) => {
      const file = path.join(root, "src", "a.txt");
      fs.mkdirSync(path.dirname(file));
      fs.writeFileSync(file, "hi");
      const abs = fs.realpathSync(file);
      assert.equal(resolveWorkspacePath(root, abs), abs);
    });
  });

  it("symlink inside the workspace pointing outside throws", () => {
    withNeighbor((root, base) => {
      const outside = path.join(base, "outside.txt");
      fs.writeFileSync(outside, "nope");
      fs.symlinkSync(outside, path.join(root, "link"));
      assert.throws(
        () => resolveWorkspacePath(root, "link"),
        /path escapes workspace/,
      );
    });
  });

  it(`"foo\\0bar" throws`, () => {
    withRoot((root) => {
      assert.throws(
        () => resolveWorkspacePath(root, "foo\0bar"),
        (err: unknown) => {
          assert.ok(err instanceof WorkspacePathError);
          assert.equal(err.code, "nul");
          assert.match(err.message, /path escapes workspace/);
          return true;
        },
      );
    });
  });

  it(`missing file inside ("nope.txt") still resolves`, () => {
    withRoot((root) => {
      const resolved = resolveWorkspacePath(root, "nope.txt");
      const rootReal = fs.realpathSync(root);
      assert.equal(resolved, path.join(rootReal, "nope.txt"));
      assert.ok(resolved.endsWith("nope.txt"));
      const rel = path.relative(rootReal, resolved);
      assert.equal(rel.startsWith(".."), false);
    });
  });
});
