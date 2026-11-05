import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const entry = path.join(root, "src", "index.ts");

function runCli(args: string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", entry, ...args], {
      cwd: root,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

describe("openagent CLI stub", () => {
  it("--help exits 0 and prints Usage:", async () => {
    const result = await runCli(["--help"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Usage:/);
  });

  it("default run exits 0 and prints CLI stub", async () => {
    const result = await runCli([]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /CLI stub/);
  });
});
