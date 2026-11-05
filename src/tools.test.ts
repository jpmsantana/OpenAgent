import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createReadTools, READ_MAX_BYTES } from "./tools.ts";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oa-tool-"));
}

async function withTree(
  fn: (root: string, base: string) => Promise<void>,
): Promise<void> {
  const base = tmp();
  const root = path.join(base, "ws");
  fs.mkdirSync(root);
  try {
    await fn(root, base);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function tools() {
  const [listDir, readFile] = createReadTools();
  return { listDir, readFile };
}

describe("createReadTools", () => {
  it("returns tools named list_dir and read_file", () => {
    assert.deepEqual(
      createReadTools().map((tool) => tool.name),
      ["list_dir", "read_file"],
    );
  });

  it("list_dir on a fixture with a.txt and sub/ lists both", async () => {
    await withTree(async (root) => {
      fs.writeFileSync(path.join(root, "a.txt"), "hi");
      fs.mkdirSync(path.join(root, "sub"));
      const { listDir } = tools();
      const parsed = JSON.parse(
        await listDir.execute({ path: "." }, { workspaceRoot: root }),
      ) as {
        path: string;
        entries: { name: string; type: string }[];
      };
      assert.equal(parsed.path, ".");
      assert.deepEqual(
        parsed.entries.map((e) => e.name),
        ["a.txt", "sub"].sort((a, b) => a.localeCompare(b)),
      );
      const byName = Object.fromEntries(
        parsed.entries.map((e) => [e.name, e.type]),
      );
      assert.equal(byName["a.txt"], "file");
      assert.equal(byName.sub, "dir");
    });
  });

  it("list_dir default path lists the workspace root", async () => {
    await withTree(async (root) => {
      fs.writeFileSync(path.join(root, "root.txt"), "x");
      const { listDir } = tools();
      const parsed = JSON.parse(
        await listDir.execute({}, { workspaceRoot: root }),
      ) as { path: string; entries: { name: string }[] };
      assert.equal(parsed.path, ".");
      assert.ok(parsed.entries.some((e) => e.name === "root.txt"));
    });
  });

  it("list_dir on a file → Error: not a directory", async () => {
    await withTree(async (root) => {
      fs.writeFileSync(path.join(root, "a.txt"), "hi");
      const { listDir } = tools();
      const result = await listDir.execute(
        { path: "a.txt" },
        { workspaceRoot: root },
      );
      assert.match(result, /Error: not a directory/);
    });
  });

  it("list_dir on ../secret → Error: path escapes workspace", async () => {
    await withTree(async (root, base) => {
      fs.writeFileSync(path.join(base, "secret"), "nope");
      const { listDir } = tools();
      const result = await listDir.execute(
        { path: "../secret" },
        { workspaceRoot: root },
      );
      assert.match(result, /Error: path escapes workspace/);
    });
  });

  it("read_file returns exact contents", async () => {
    await withTree(async (root) => {
      fs.writeFileSync(path.join(root, "a.txt"), "hello\nworld");
      const { readFile } = tools();
      const result = await readFile.execute(
        { path: "a.txt" },
        { workspaceRoot: root },
      );
      assert.equal(result, "hello\nworld");
    });
  });

  it("read_file missing → Error: not found", async () => {
    await withTree(async (root) => {
      const { readFile } = tools();
      const result = await readFile.execute(
        { path: "missing.txt" },
        { workspaceRoot: root },
      );
      assert.match(result, /Error: not found/);
    });
  });

  it("read_file directory → Error: is a directory", async () => {
    await withTree(async (root) => {
      fs.mkdirSync(path.join(root, "sub"));
      const { readFile } = tools();
      const result = await readFile.execute(
        { path: "sub" },
        { workspaceRoot: root },
      );
      assert.match(result, /Error: is a directory/);
    });
  });

  it("read_file file of READ_MAX_BYTES + 1 bytes → Error: file too large", async () => {
    await withTree(async (root) => {
      fs.writeFileSync(
        path.join(root, "big.bin"),
        Buffer.alloc(READ_MAX_BYTES + 1),
      );
      const { readFile } = tools();
      const result = await readFile.execute(
        { path: "big.bin" },
        { workspaceRoot: root },
      );
      assert.match(result, /Error: file too large/);
    });
  });

  it("read_file a file containing NUL → Error: binary file", async () => {
    await withTree(async (root) => {
      fs.writeFileSync(path.join(root, "bin.dat"), Buffer.from("a\0b"));
      const { readFile } = tools();
      const result = await readFile.execute(
        { path: "bin.dat" },
        { workspaceRoot: root },
      );
      assert.match(result, /Error: binary file/);
    });
  });

  it("read_file ../outside → Error: path escapes workspace", async () => {
    await withTree(async (root, base) => {
      fs.writeFileSync(path.join(base, "outside"), "nope");
      const { readFile } = tools();
      const result = await readFile.execute(
        { path: "../outside" },
        { workspaceRoot: root },
      );
      assert.match(result, /Error: path escapes workspace/);
    });
  });
});
