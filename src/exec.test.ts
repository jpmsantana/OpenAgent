import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  COMMAND_MAX_BYTES,
  ExecArgvError,
  formatCommandResult,
  runCommand,
} from "./exec.ts";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oa-exec-"));
}

async function withTree(
  fn: (root: string, base: string) => Promise<void>,
): Promise<void> {
  const base = tmp();
  const root = path.join(base, "ws");
  fs.mkdirSync(root);
  try {
    await fn(fs.realpathSync(root), base);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

describe("runCommand", () => {
  it("hello stdout", async () => {
    await withTree(async (root) => {
      const result = await runCommand({
        argv: ["node", "-e", "process.stdout.write('hi')"],
        cwd: root,
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, "hi");
      assert.equal(result.timedOut, false);
    });
  });

  it("stderr and non-zero exit", async () => {
    await withTree(async (root) => {
      const result = await runCommand({
        argv: ["node", "-e", "process.stderr.write('nope'); process.exit(2)"],
        cwd: root,
      });
      assert.equal(result.exitCode, 2);
      assert.match(result.stderr, /nope/);
    });
  });

  it("does not invoke a shell", async () => {
    await withTree(async (root) => {
      const result = await runCommand({
        argv: [
          "node",
          "-e",
          "process.stdout.write(process.argv.slice(1).join(','))",
          "a && rm",
          "-rf",
        ],
        cwd: root,
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, "a && rm,-rf");
    });
  });

  it("uses the given cwd", async () => {
    await withTree(async (root) => {
      const result = await runCommand({
        argv: ["node", "-e", "process.stdout.write(process.cwd())"],
        cwd: root,
      });
      assert.equal(result.stdout, root);
    });
  });

  it("bare node name uses PATH", async () => {
    await withTree(async (root) => {
      const result = await runCommand({
        argv: ["node", "-e", "process.stdout.write('ok')"],
        cwd: root,
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, "ok");
    });
  });

  it("path-style argv[0] outside the workspace throws", async () => {
    await withTree(async (root, base) => {
      const marker = path.join(base, "ran.txt");
      const script = path.join(base, "outside.sh");
      fs.writeFileSync(script, `#!/bin/sh\necho ran > "${marker}"\n`, {
        mode: 0o755,
      });
      await assert.rejects(
        () => runCommand({ argv: ["../outside.sh"], cwd: root }),
        /path escapes workspace/,
      );
      assert.equal(fs.existsSync(marker), false);
    });
  });

  it("absolute path outside the workspace throws", async () => {
    await withTree(async (root) => {
      await assert.rejects(
        () => runCommand({ argv: ["/bin/sh"], cwd: root }),
        /path escapes workspace/,
      );
    });
  });

  it("workspace-relative program runs", async () => {
    await withTree(async (root) => {
      fs.writeFileSync(path.join(root, "script.sh"), "#!/bin/sh\necho hi\n", {
        mode: 0o755,
      });
      const result = await runCommand({
        argv: ["./script.sh"],
        cwd: root,
      });
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /^hi\n?$/);
    });
  });

  it("timeout returns a result", { timeout: 5000 }, async () => {
    await withTree(async (root) => {
      const start = Date.now();
      const result = await runCommand({
        argv: ["node", "-e", "setTimeout(() => {}, 10_000)"],
        cwd: root,
        timeoutMs: 200,
      });
      assert.equal(result.timedOut, true);
      assert.ok(Date.now() - start < 2000);
      assert.match(
        formatCommandResult(result, 200),
        /Error: command timed out after 200 ms/,
      );
    });
  });

  it("caller abort throws AbortError", { timeout: 5000 }, async () => {
    await withTree(async (root) => {
      const controller = new AbortController();
      const pending = runCommand({
        argv: ["node", "-e", "setTimeout(() => {}, 10_000)"],
        cwd: root,
        signal: controller.signal,
      });
      await new Promise((r) => setTimeout(r, 50));
      controller.abort();
      await assert.rejects(pending, (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.name, "AbortError");
        return true;
      });
    });
  });

  it("truncates output over COMMAND_MAX_BYTES", { timeout: 5000 }, async () => {
    await withTree(async (root) => {
      const result = await runCommand({
        argv: ["node", "-e", "process.stdout.write('x'.repeat(40000))"],
        cwd: root,
      });
      assert.equal(result.truncated, true);
      const n =
        Buffer.byteLength(result.stdout, "utf8") +
        Buffer.byteLength(result.stderr, "utf8");
      assert.ok(n <= COMMAND_MAX_BYTES);
      assert.match(formatCommandResult(result), /\[truncated\]/);
    });
  });

  it("invalid argv throws ExecArgvError", async () => {
    await withTree(async (root) => {
      const cases: string[][] = [
        [],
        [""],
        ["ok", 1 as unknown as string],
        ["node\0"],
      ];
      for (const argv of cases) {
        await assert.rejects(
          () => runCommand({ argv, cwd: root }),
          (err: unknown) => {
            assert.ok(err instanceof ExecArgvError);
            assert.match(err.message, /invalid arguments/);
            return true;
          },
        );
      }
    });
  });
});
