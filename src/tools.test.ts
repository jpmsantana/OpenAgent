import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { formatCommandResult } from "./exec.ts";
import {
  createTools,
  GREP_MAX_MATCHES,
  READ_MAX_BYTES,
} from "./tools.ts";

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

function tool(name: string) {
  const found = createTools().find((entry) => entry.name === name);
  assert.ok(found, name);
  return found;
}

describe("createTools", () => {
  it("returns tools named list_dir, read_file, grep, write_file, str_replace, delete_file, and run_command", () => {
    assert.deepEqual(
      createTools().map((entry) => entry.name),
      [
        "list_dir",
        "read_file",
        "grep",
        "write_file",
        "str_replace",
        "delete_file",
        "run_command",
      ],
    );
  });

  it("list_dir on a fixture with a.txt and sub/ lists both", async () => {
    await withTree(async (root) => {
      fs.writeFileSync(path.join(root, "a.txt"), "hi");
      fs.mkdirSync(path.join(root, "sub"));
      const listDir = tool("list_dir");
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
      const listDir = tool("list_dir");
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
      const listDir = tool("list_dir");
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
      const listDir = tool("list_dir");
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
      const readFile = tool("read_file");
      const result = await readFile.execute(
        { path: "a.txt" },
        { workspaceRoot: root },
      );
      assert.equal(result, "hello\nworld");
    });
  });

  it("read_file missing → Error: not found", async () => {
    await withTree(async (root) => {
      const readFile = tool("read_file");
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
      const readFile = tool("read_file");
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
      const readFile = tool("read_file");
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
      const readFile = tool("read_file");
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
      const readFile = tool("read_file");
      const result = await readFile.execute(
        { path: "../outside" },
        { workspaceRoot: root },
      );
      assert.match(result, /Error: path escapes workspace/);
    });
  });

  it("offset and limit return a line window with a header", async () => {
    await withTree(async (root) => {
      fs.writeFileSync(path.join(root, "a.txt"), "l1\nl2\nl3\nl4\n");
      const readFile = tool("read_file");
      const result = await readFile.execute(
        { path: "a.txt", offset: 2, limit: 2 },
        { workspaceRoot: root },
      );
      assert.equal(result, "lines 2-3 of 4\nl2\nl3");
    });
  });

  it("offset without limit reads through the last line", async () => {
    await withTree(async (root) => {
      fs.writeFileSync(path.join(root, "a.txt"), "l1\nl2\nl3\nl4\n");
      const readFile = tool("read_file");
      const result = await readFile.execute(
        { path: "a.txt", offset: 3 },
        { workspaceRoot: root },
      );
      assert.equal(result, "lines 3-4 of 4\nl3\nl4");
    });
  });

  it("limit without offset starts at line 1", async () => {
    await withTree(async (root) => {
      fs.writeFileSync(path.join(root, "a.txt"), "l1\nl2\nl3\nl4\n");
      const readFile = tool("read_file");
      const result = await readFile.execute(
        { path: "a.txt", limit: 1 },
        { workspaceRoot: root },
      );
      assert.equal(result, "lines 1-1 of 4\nl1");
    });
  });

  it("offset past the end returns lines 0-0 of total", async () => {
    await withTree(async (root) => {
      fs.writeFileSync(path.join(root, "a.txt"), "l1\nl2\nl3\nl4\n");
      const readFile = tool("read_file");
      const result = await readFile.execute(
        { path: "a.txt", offset: 99, limit: 1 },
        { workspaceRoot: root },
      );
      assert.equal(result, "lines 0-0 of 4\n");
    });
  });

  it("invalid offset or limit → Error: invalid arguments for read_file", async () => {
    await withTree(async (root) => {
      fs.writeFileSync(path.join(root, "a.txt"), "l1\n");
      const readFile = tool("read_file");
      const ctx = { workspaceRoot: root };
      assert.equal(
        await readFile.execute({ path: "a.txt", offset: 0 }, ctx),
        "Error: invalid arguments for read_file",
      );
      assert.equal(
        await readFile.execute({ path: "a.txt", offset: 1.5 }, ctx),
        "Error: invalid arguments for read_file",
      );
      assert.equal(
        await readFile.execute({ path: "a.txt", limit: -1 }, ctx),
        "Error: invalid arguments for read_file",
      );
      assert.equal(
        await readFile.execute({ path: "a.txt", offset: "1" }, ctx),
        "Error: invalid arguments for read_file",
      );
    });
  });

  it("window still rejects files larger than READ_MAX_BYTES", async () => {
    await withTree(async (root) => {
      fs.writeFileSync(
        path.join(root, "big.bin"),
        Buffer.alloc(READ_MAX_BYTES + 1),
      );
      const readFile = tool("read_file");
      const result = await readFile.execute(
        { path: "big.bin", offset: 1, limit: 1 },
        { workspaceRoot: root },
      );
      assert.match(result, /Error: file too large/);
    });
  });
});

describe("write_file", () => {
  it("confirm true creates the file with exact contents", async () => {
    await withTree(async (root) => {
      const writeFile = tool("write_file");
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
      const writeFile = tool("write_file");
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
      const writeFile = tool("write_file");
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
      const writeFile = tool("write_file");
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
      const writeFile = tool("write_file");
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
      const writeFile = tool("write_file");
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
      const writeFile = tool("write_file");
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
      const writeFile = tool("write_file");
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
      const writeFile = tool("write_file");
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
      const writeFile = tool("write_file");
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
      const writeFile = tool("write_file");
      const result = await writeFile.execute(
        { path: "empty.txt", content: "" },
        { workspaceRoot: root, confirm: async () => true },
      );
      assert.equal(result, "Wrote 0 bytes to empty.txt");
      assert.equal(fs.readFileSync(path.join(root, "empty.txt"), "utf8"), "");
    });
  });
});

describe("str_replace", () => {
  function replaceTool() {
    return tool("str_replace");
  }

  it("confirm true replaces a unique substring", async () => {
    await withTree(async (root) => {
      fs.writeFileSync(path.join(root, "a.ts"), "const x = 1;\n");
      const result = await replaceTool().execute(
        {
          path: "a.ts",
          old_string: "const x = 1;",
          new_string: "const x = 2;",
        },
        { workspaceRoot: root, confirm: async () => true },
      );
      assert.equal(result, "Replaced in a.ts");
      assert.equal(fs.readFileSync(path.join(root, "a.ts"), "utf8"), "const x = 2;\n");
    });
  });

  it("confirm false leaves the file unchanged", async () => {
    await withTree(async (root) => {
      fs.writeFileSync(path.join(root, "a.ts"), "const x = 1;\n");
      const result = await replaceTool().execute(
        {
          path: "a.ts",
          old_string: "const x = 1;",
          new_string: "const x = 2;",
        },
        { workspaceRoot: root, confirm: async () => false },
      );
      assert.equal(result, "User denied replace in a.ts.");
      assert.equal(fs.readFileSync(path.join(root, "a.ts"), "utf8"), "const x = 1;\n");
    });
  });

  it("missing confirm is denied and does not write", async () => {
    await withTree(async (root) => {
      fs.writeFileSync(path.join(root, "a.ts"), "const x = 1;\n");
      const result = await replaceTool().execute(
        {
          path: "a.ts",
          old_string: "const x = 1;",
          new_string: "const x = 2;",
        },
        { workspaceRoot: root },
      );
      assert.equal(result, "User denied replace in a.ts.");
      assert.equal(fs.readFileSync(path.join(root, "a.ts"), "utf8"), "const x = 1;\n");
    });
  });

  it("two matches do not confirm", async () => {
    await withTree(async (root) => {
      fs.writeFileSync(path.join(root, "a.ts"), "x x\n");
      let called = 0;
      const result = await replaceTool().execute(
        { path: "a.ts", old_string: "x", new_string: "y" },
        {
          workspaceRoot: root,
          confirm: async () => {
            called += 1;
            return true;
          },
        },
      );
      assert.match(result, /old_string matched 2 times/);
      assert.equal(called, 0);
      assert.equal(fs.readFileSync(path.join(root, "a.ts"), "utf8"), "x x\n");
    });
  });

  it("zero matches do not confirm", async () => {
    await withTree(async (root) => {
      fs.writeFileSync(path.join(root, "a.ts"), "const x = 1;\n");
      let called = 0;
      const result = await replaceTool().execute(
        { path: "a.ts", old_string: "nope", new_string: "y" },
        {
          workspaceRoot: root,
          confirm: async () => {
            called += 1;
            return true;
          },
        },
      );
      assert.match(result, /old_string not found/);
      assert.equal(called, 0);
    });
  });

  it("empty old_string is invalid and does not confirm", async () => {
    await withTree(async (root) => {
      fs.writeFileSync(path.join(root, "a.ts"), "const x = 1;\n");
      let called = 0;
      const result = await replaceTool().execute(
        { path: "a.ts", old_string: "", new_string: "y" },
        {
          workspaceRoot: root,
          confirm: async () => {
            called += 1;
            return true;
          },
        },
      );
      assert.equal(result, "Error: invalid arguments for str_replace");
      assert.equal(called, 0);
    });
  });

  it("missing file does not confirm", async () => {
    await withTree(async (root) => {
      let called = 0;
      const result = await replaceTool().execute(
        { path: "gone.ts", old_string: "a", new_string: "b" },
        {
          workspaceRoot: root,
          confirm: async () => {
            called += 1;
            return true;
          },
        },
      );
      assert.match(result, /Error: not found:/);
      assert.equal(called, 0);
    });
  });

  it("directory path does not confirm", async () => {
    await withTree(async (root) => {
      fs.mkdirSync(path.join(root, "sub"));
      let called = 0;
      const result = await replaceTool().execute(
        { path: "sub", old_string: "a", new_string: "b" },
        {
          workspaceRoot: root,
          confirm: async () => {
            called += 1;
            return true;
          },
        },
      );
      assert.match(result, /Error: is a directory:/);
      assert.equal(called, 0);
    });
  });

  it("empty new_string removes the unique span", async () => {
    await withTree(async (root) => {
      fs.writeFileSync(path.join(root, "a.ts"), "keep DROP rest\n");
      const result = await replaceTool().execute(
        { path: "a.ts", old_string: "DROP ", new_string: "" },
        { workspaceRoot: root, confirm: async () => true },
      );
      assert.equal(result, "Replaced in a.ts");
      assert.equal(fs.readFileSync(path.join(root, "a.ts"), "utf8"), "keep rest\n");
    });
  });

  it("escape path does not confirm", async () => {
    await withTree(async (root, base) => {
      fs.writeFileSync(path.join(base, "outside.ts"), "secret\n");
      let called = 0;
      const result = await replaceTool().execute(
        { path: "../outside.ts", old_string: "secret", new_string: "nope" },
        {
          workspaceRoot: root,
          confirm: async () => {
            called += 1;
            return true;
          },
        },
      );
      assert.match(result, /path escapes workspace/);
      assert.equal(called, 0);
      assert.equal(fs.readFileSync(path.join(base, "outside.ts"), "utf8"), "secret\n");
    });
  });
});

describe("delete_file", () => {
  function deleteTool() {
    return tool("delete_file");
  }

  it("confirm true unlinks the file", async () => {
    await withTree(async (root) => {
      fs.writeFileSync(path.join(root, "a.txt"), "x");
      const result = await deleteTool().execute(
        { path: "a.txt" },
        { workspaceRoot: root, confirm: async () => true },
      );
      assert.equal(result, "Deleted a.txt");
      assert.equal(fs.existsSync(path.join(root, "a.txt")), false);
    });
  });

  it("confirm false leaves the file", async () => {
    await withTree(async (root) => {
      fs.writeFileSync(path.join(root, "a.txt"), "x");
      const result = await deleteTool().execute(
        { path: "a.txt" },
        { workspaceRoot: root, confirm: async () => false },
      );
      assert.equal(result, "User denied delete of a.txt.");
      assert.equal(fs.existsSync(path.join(root, "a.txt")), true);
    });
  });

  it("missing confirm is denied and does not unlink", async () => {
    await withTree(async (root) => {
      fs.writeFileSync(path.join(root, "a.txt"), "x");
      const result = await deleteTool().execute(
        { path: "a.txt" },
        { workspaceRoot: root },
      );
      assert.equal(result, "User denied delete of a.txt.");
      assert.equal(fs.existsSync(path.join(root, "a.txt")), true);
    });
  });

  it("directory does not confirm and remains", async () => {
    await withTree(async (root) => {
      fs.mkdirSync(path.join(root, "sub"));
      fs.writeFileSync(path.join(root, "sub", "f.txt"), "x");
      let called = 0;
      const result = await deleteTool().execute(
        { path: "sub" },
        {
          workspaceRoot: root,
          confirm: async () => {
            called += 1;
            return true;
          },
        },
      );
      assert.match(result, /Error: is a directory:/);
      assert.equal(called, 0);
      assert.equal(fs.existsSync(path.join(root, "sub", "f.txt")), true);
    });
  });

  it("missing path does not confirm", async () => {
    await withTree(async (root) => {
      let called = 0;
      const result = await deleteTool().execute(
        { path: "gone.txt" },
        {
          workspaceRoot: root,
          confirm: async () => {
            called += 1;
            return true;
          },
        },
      );
      assert.match(result, /Error: not found:/);
      assert.equal(called, 0);
    });
  });

  it("invalid args do not confirm", async () => {
    await withTree(async (root) => {
      let called = 0;
      const result = await deleteTool().execute(
        {},
        {
          workspaceRoot: root,
          confirm: async () => {
            called += 1;
            return true;
          },
        },
      );
      assert.equal(result, "Error: invalid arguments for delete_file");
      assert.equal(called, 0);
    });
  });

  it("symlink to a file inside the workspace is rejected", async () => {
    await withTree(async (root) => {
      fs.writeFileSync(path.join(root, "target.txt"), "keep");
      fs.symlinkSync(path.join(root, "target.txt"), path.join(root, "link.txt"));
      let called = 0;
      const result = await deleteTool().execute(
        { path: "link.txt" },
        {
          workspaceRoot: root,
          confirm: async () => {
            called += 1;
            return true;
          },
        },
      );
      assert.match(result, /path escapes workspace/);
      assert.equal(called, 0);
      assert.equal(fs.readFileSync(path.join(root, "target.txt"), "utf8"), "keep");
    });
  });

  it("escape path does not confirm", async () => {
    await withTree(async (root, base) => {
      fs.writeFileSync(path.join(base, "outside.txt"), "secret");
      let called = 0;
      const result = await deleteTool().execute(
        { path: "../outside.txt" },
        {
          workspaceRoot: root,
          confirm: async () => {
            called += 1;
            return true;
          },
        },
      );
      assert.match(result, /path escapes workspace/);
      assert.equal(called, 0);
      assert.equal(fs.existsSync(path.join(base, "outside.txt")), true);
    });
  });
});

describe("run_command", () => {
  function runTool() {
    return tool("run_command");
  }

  it("confirm true calls run and formats the result", async () => {
    await withTree(async (root) => {
      const stub = {
        exitCode: 0,
        stdout: "hi",
        stderr: "",
        timedOut: false,
        truncated: false,
      };
      let ran: { argv: string[]; cwd: string; signal?: AbortSignal } | undefined;
      const result = await runTool().execute(
        { argv: ["node", "-e", "1"] },
        {
          workspaceRoot: root,
          confirm: async () => true,
          run: async (opts) => {
            ran = opts;
            return stub;
          },
        },
      );
      assert.deepEqual(ran, {
        argv: ["node", "-e", "1"],
        cwd: root,
        signal: undefined,
      });
      assert.equal(result, formatCommandResult(stub));
    });
  });

  it("confirm false does not call run", async () => {
    await withTree(async (root) => {
      let called = 0;
      const result = await runTool().execute(
        { argv: ["node", "-e", "1"] },
        {
          workspaceRoot: root,
          confirm: async () => false,
          run: async () => {
            called += 1;
            return {
              exitCode: 0,
              stdout: "",
              stderr: "",
              timedOut: false,
              truncated: false,
            };
          },
        },
      );
      assert.equal(result, `User denied command: ${JSON.stringify(["node", "-e", "1"])}`);
      assert.equal(called, 0);
    });
  });

  it("missing confirm is denied and does not run", async () => {
    await withTree(async (root) => {
      let called = 0;
      const result = await runTool().execute(
        { argv: ["node", "-e", "1"] },
        {
          workspaceRoot: root,
          run: async () => {
            called += 1;
            return {
              exitCode: 0,
              stdout: "",
              stderr: "",
              timedOut: false,
              truncated: false,
            };
          },
        },
      );
      assert.equal(result, `User denied command: ${JSON.stringify(["node", "-e", "1"])}`);
      assert.equal(called, 0);
    });
  });

  it("invalid argv does not confirm", async () => {
    await withTree(async (root) => {
      let called = 0;
      const confirm = async (): Promise<boolean> => {
        called += 1;
        return true;
      };
      const tool = runTool();
      assert.equal(
        await tool.execute({}, { workspaceRoot: root, confirm }),
        "Error: invalid arguments for run_command",
      );
      assert.equal(
        await tool.execute({ argv: [] }, { workspaceRoot: root, confirm }),
        "Error: invalid arguments for run_command",
      );
      assert.equal(
        await tool.execute({ argv: [1] }, { workspaceRoot: root, confirm }),
        "Error: invalid arguments for run_command",
      );
      assert.equal(called, 0);
    });
  });

  it("AbortError from run is rethrown", async () => {
    await withTree(async (root) => {
      const err = new Error("aborted");
      err.name = "AbortError";
      await assert.rejects(
        () =>
          runTool().execute(
            { argv: ["node", "-e", "1"] },
            {
              workspaceRoot: root,
              confirm: async () => true,
              run: async () => {
                throw err;
              },
            },
          ),
        (caught: unknown) => {
          assert.equal(caught, err);
          return true;
        },
      );
    });
  });

  it("path escape after confirm does not spawn outside", async () => {
    await withTree(async (root, base) => {
      const marker = path.join(base, "ran.txt");
      fs.writeFileSync(path.join(base, "outside.sh"), `#!/bin/sh\necho ran > "${marker}"\n`, {
        mode: 0o755,
      });
      const result = await runTool().execute(
        { argv: ["../outside.sh"] },
        { workspaceRoot: root, confirm: async () => true },
      );
      assert.match(result, /path escapes workspace/);
      assert.equal(fs.existsSync(marker), false);
    });
  });
});

describe("grep", () => {
  function grepTool() {
    return tool("grep");
  }

  it("returns path:line:text hits in walk order", async () => {
    await withTree(async (root) => {
      fs.mkdirSync(path.join(root, "src"));
      fs.writeFileSync(path.join(root, "src", "a.ts"), "first\nfoo\n");
      fs.writeFileSync(path.join(root, "src", "b.ts"), "foo\n");
      let confirmed = 0;
      const result = await grepTool().execute(
        { pattern: "foo" },
        {
          workspaceRoot: root,
          confirm: async () => {
            confirmed += 1;
            return true;
          },
        },
      );
      const aRel = path.relative(root, path.join(root, "src", "a.ts"));
      const bRel = path.relative(root, path.join(root, "src", "b.ts"));
      assert.equal(result, `${aRel}:2:foo\n${bRel}:1:foo`);
      assert.equal(confirmed, 0);
    });
  });

  it("skips node_modules when descending", async () => {
    await withTree(async (root) => {
      fs.writeFileSync(path.join(root, "hit.txt"), "SECRET\n");
      fs.mkdirSync(path.join(root, "node_modules"));
      fs.writeFileSync(path.join(root, "node_modules", "hidden.txt"), "SECRET\n");
      const result = await grepTool().execute(
        { pattern: "SECRET" },
        { workspaceRoot: root },
      );
      const hitRel = path.relative(root, path.join(root, "hit.txt"));
      assert.equal(result, `${hitRel}:1:SECRET`);
      assert.equal(result.includes("hidden"), false);
      assert.equal(result.includes("node_modules"), false);
    });
  });

  it("skips .git and dist when descending", async () => {
    await withTree(async (root) => {
      fs.writeFileSync(path.join(root, "keep.txt"), "TOKEN\n");
      fs.mkdirSync(path.join(root, ".git"));
      fs.writeFileSync(path.join(root, ".git", "hidden.txt"), "TOKEN\n");
      fs.mkdirSync(path.join(root, "dist"));
      fs.writeFileSync(path.join(root, "dist", "hidden.txt"), "TOKEN\n");
      const result = await grepTool().execute(
        { pattern: "TOKEN" },
        { workspaceRoot: root },
      );
      const keepRel = path.relative(root, path.join(root, "keep.txt"));
      assert.equal(result, `${keepRel}:1:TOKEN`);
      assert.equal(result.includes(".git"), false);
      assert.equal(result.includes("dist"), false);
    });
  });

  it("searches an explicit node_modules path", async () => {
    await withTree(async (root) => {
      fs.mkdirSync(path.join(root, "node_modules"));
      fs.writeFileSync(path.join(root, "node_modules", "pkg.txt"), "INSIDE\n");
      const result = await grepTool().execute(
        { pattern: "INSIDE", path: "node_modules" },
        { workspaceRoot: root },
      );
      const rel = path.relative(
        root,
        path.join(root, "node_modules", "pkg.txt"),
      );
      assert.equal(result, `${rel}:1:INSIDE`);
    });
  });

  it("caps at GREP_MAX_MATCHES and marks truncated", async () => {
    await withTree(async (root) => {
      const lines = Array.from({ length: 60 }, () => "x");
      fs.writeFileSync(path.join(root, "lots.txt"), `${lines.join("\n")}\n`);
      const result = await grepTool().execute(
        { pattern: "x" },
        { workspaceRoot: root },
      );
      const rel = path.relative(root, path.join(root, "lots.txt"));
      const matchLines = result
        .split("\n")
        .filter((line) => line !== "" && line !== "[truncated]");
      assert.equal(matchLines.length, GREP_MAX_MATCHES);
      assert.equal(matchLines[0], `${rel}:1:x`);
      assert.equal(matchLines[GREP_MAX_MATCHES - 1], `${rel}:${GREP_MAX_MATCHES}:x`);
      assert.match(result, /\[truncated\]/);
    });
  });

  it("case_insensitive matches when true", async () => {
    await withTree(async (root) => {
      fs.writeFileSync(path.join(root, "note.txt"), "Foo\n");
      const sensitive = await grepTool().execute(
        { pattern: "foo" },
        { workspaceRoot: root },
      );
      assert.equal(sensitive, "No matches.");
      const insensitive = await grepTool().execute(
        { pattern: "foo", case_insensitive: true },
        { workspaceRoot: root },
      );
      const rel = path.relative(root, path.join(root, "note.txt"));
      assert.equal(insensitive, `${rel}:1:Foo`);
    });
  });

  it("invalid regex returns Error: invalid regex", async () => {
    await withTree(async (root) => {
      const result = await grepTool().execute(
        { pattern: "[" },
        { workspaceRoot: root },
      );
      assert.equal(result, "Error: invalid regex");
    });
  });

  it("invalid arguments for missing, empty, or bad case_insensitive", async () => {
    await withTree(async (root) => {
      const grep = grepTool();
      assert.equal(
        await grep.execute({}, { workspaceRoot: root }),
        "Error: invalid arguments for grep",
      );
      assert.equal(
        await grep.execute({ pattern: "" }, { workspaceRoot: root }),
        "Error: invalid arguments for grep",
      );
      assert.equal(
        await grep.execute(
          { pattern: "a", case_insensitive: "yes" },
          { workspaceRoot: root },
        ),
        "Error: invalid arguments for grep",
      );
    });
  });

  it("path escape → Error: path escapes workspace", async () => {
    await withTree(async (root, base) => {
      fs.writeFileSync(path.join(base, "outside"), "secret\n");
      const result = await grepTool().execute(
        { pattern: "secret", path: "../outside" },
        { workspaceRoot: root },
      );
      assert.match(result, /path escapes workspace/);
    });
  });

  it("missing path → Error: not found", async () => {
    await withTree(async (root) => {
      const result = await grepTool().execute(
        { pattern: "a", path: "nope" },
        { workspaceRoot: root },
      );
      assert.equal(result, "Error: not found: nope");
    });
  });

  it("skips binary files that contain the pattern", async () => {
    await withTree(async (root) => {
      fs.writeFileSync(path.join(root, "bin.dat"), Buffer.from("foo\0bar"));
      const result = await grepTool().execute(
        { pattern: "foo" },
        { workspaceRoot: root },
      );
      assert.equal(result, "No matches.");
    });
  });

  it("path to a single file does not search siblings", async () => {
    await withTree(async (root) => {
      fs.writeFileSync(path.join(root, "only.txt"), "foo\n");
      fs.writeFileSync(path.join(root, "other.txt"), "foo\n");
      const result = await grepTool().execute(
        { pattern: "foo", path: "only.txt" },
        { workspaceRoot: root },
      );
      const rel = path.relative(root, path.join(root, "only.txt"));
      assert.equal(result, `${rel}:1:foo`);
      assert.equal(result.includes("other"), false);
    });
  });

  it("no matches returns No matches.", async () => {
    await withTree(async (root) => {
      fs.writeFileSync(path.join(root, "a.txt"), "hello\n");
      const result = await grepTool().execute(
        { pattern: "zzz" },
        { workspaceRoot: root },
      );
      assert.equal(result, "No matches.");
    });
  });

  it("already-aborted signal rejects with AbortError", async () => {
    await withTree(async (root) => {
      const abort = new AbortController();
      abort.abort();
      await assert.rejects(
        () =>
          grepTool().execute(
            { pattern: "a" },
            { workspaceRoot: root, signal: abort.signal },
          ),
        (err: unknown) => {
          assert.equal((err as Error).name, "AbortError");
          return true;
        },
      );
    });
  });
});
