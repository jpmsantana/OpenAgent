import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createTools, READ_MAX_BYTES } from "./tools.ts";

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
  const [listDir, readFile, writeFile] = createTools();
  return { listDir, readFile, writeFile };
}

describe("createTools", () => {
  it("returns tools named list_dir, read_file, and write_file", () => {
    assert.deepEqual(
      createTools().map((tool) => tool.name),
      ["list_dir", "read_file", "write_file"],
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

describe("write_file", () => {
  it("confirm true creates the file with exact contents", async () => {
    await withTree(async (root) => {
      const { writeFile } = tools();
      const result = await writeFile.execute(
        { path: "a.txt", content: "hello" },
        { workspaceRoot: root, confirm: async () => true },
      );
      assert.match(result, /Wrote \d+ bytes to/);
      assert.equal(result, "Wrote 5 bytes to a.txt");
      assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "hello");
    });
  });

  it("confirm false does not create the file", async () => {
    await withTree(async (root) => {
      const { writeFile } = tools();
      const result = await writeFile.execute(
        { path: "a.txt", content: "hello" },
        { workspaceRoot: root, confirm: async () => false },
      );
      assert.equal(result, "User denied write to a.txt.");
      assert.equal(fs.existsSync(path.join(root, "a.txt")), false);
    });
  });

  it("missing confirm is denied and does not write", async () => {
    await withTree(async (root) => {
      const { writeFile } = tools();
      const result = await writeFile.execute(
        { path: "a.txt", content: "hello" },
        { workspaceRoot: root },
      );
      assert.equal(result, "User denied write to a.txt.");
      assert.equal(fs.existsSync(path.join(root, "a.txt")), false);
    });
  });

  it("../outside.txt → Error: path escapes workspace, confirm not called", async () => {
    await withTree(async (root, base) => {
      const { writeFile } = tools();
      let called = 0;
      const result = await writeFile.execute(
        { path: "../outside.txt", content: "nope" },
        {
          workspaceRoot: root,
          confirm: async () => {
            called += 1;
            return true;
          },
        },
      );
      assert.match(result, /Error: path escapes workspace/);
      assert.equal(called, 0);
      assert.equal(fs.existsSync(path.join(base, "outside.txt")), false);
    });
  });

  it("overwrites an existing file after true", async () => {
    await withTree(async (root) => {
      fs.writeFileSync(path.join(root, "a.txt"), "old");
      const { writeFile } = tools();
      const result = await writeFile.execute(
        { path: "a.txt", content: "new" },
        { workspaceRoot: root, confirm: async () => true },
      );
      assert.equal(result, "Wrote 3 bytes to a.txt");
      assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "new");
    });
  });

  it("creates parent directory a/b/c.txt after true", async () => {
    await withTree(async (root) => {
      const { writeFile } = tools();
      const result = await writeFile.execute(
        { path: "a/b/c.txt", content: "nested" },
        { workspaceRoot: root, confirm: async () => true },
      );
      assert.equal(result, "Wrote 6 bytes to a/b/c.txt");
      assert.equal(
        fs.readFileSync(path.join(root, "a/b/c.txt"), "utf8"),
        "nested",
      );
    });
  });

  it("content of READ_MAX_BYTES + 1 → file too large, confirm not called", async () => {
    await withTree(async (root) => {
      const { writeFile } = tools();
      let called = 0;
      const result = await writeFile.execute(
        { path: "big.txt", content: "x".repeat(READ_MAX_BYTES + 1) },
        {
          workspaceRoot: root,
          confirm: async () => {
            called += 1;
            return true;
          },
        },
      );
      assert.match(result, /Error: file too large/);
      assert.equal(called, 0);
      assert.equal(fs.existsSync(path.join(root, "big.txt")), false);
    });
  });

  it("path is an existing directory → Error: is a directory", async () => {
    await withTree(async (root) => {
      fs.mkdirSync(path.join(root, "sub"));
      const { writeFile } = tools();
      let called = 0;
      const result = await writeFile.execute(
        { path: "sub", content: "x" },
        {
          workspaceRoot: root,
          confirm: async () => {
            called += 1;
            return true;
          },
        },
      );
      assert.match(result, /Error: is a directory/);
      assert.equal(called, 0);
    });
  });

  it("dangling symlink pointing outside does not write", async () => {
    await withTree(async (root, base) => {
      const outside = path.join(base, "secret");
      fs.symlinkSync(outside, path.join(root, "link"));
      let called = 0;
      const { writeFile } = tools();
      const result = await writeFile.execute(
        { path: "link", content: "pwn" },
        {
          workspaceRoot: root,
          confirm: async () => {
            called += 1;
            return true;
          },
        },
      );
      assert.match(result, /Error: path escapes workspace/);
      assert.equal(called, 0);
      assert.equal(fs.existsSync(outside), false);
    });
  });

  it("invalid arguments when path or content is missing", async () => {
    await withTree(async (root) => {
      const { writeFile } = tools();
      assert.equal(
        await writeFile.execute({ content: "x" }, { workspaceRoot: root }),
        "Error: invalid arguments for write_file",
      );
      assert.equal(
        await writeFile.execute({ path: "a.txt" }, { workspaceRoot: root }),
        "Error: invalid arguments for write_file",
      );
    });
  });

  it("empty content is allowed", async () => {
    await withTree(async (root) => {
      const { writeFile } = tools();
      const result = await writeFile.execute(
        { path: "empty.txt", content: "" },
        { workspaceRoot: root, confirm: async () => true },
      );
      assert.equal(result, "Wrote 0 bytes to empty.txt");
      assert.equal(fs.readFileSync(path.join(root, "empty.txt"), "utf8"), "");
    });
  });
});
