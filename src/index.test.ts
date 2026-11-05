import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const entry = path.join(root, "src", "index.ts");

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", entry, ...args], {
      cwd: root,
      env: { ...process.env, ...env },
    });
    child.stdin.end();
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

describe("openagent CLI", () => {
  it("--help exits 0 and prints Usage:", async () => {
    const result = await runCli(["--help"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Usage:/);
  });

  it("unreachable Ollama at startup exits 1 with serve hint", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-cli-"));
    const configPath = path.join(dir, "openagent.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ ollama: { host: "http://127.0.0.1:1" } }),
    );
    try {
      const result = await runCli([], { OPENAGENT_CONFIG: configPath });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Cannot reach Ollama/);
      assert.match(result.stderr, /ollama serve/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
