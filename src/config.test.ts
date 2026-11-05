import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_CONFIG, loadConfig } from "./config.ts";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oa-cfg-"));
}

function write(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function withTemp(fn: (dirs: { cwd: string; home: string }) => void): void {
  const cwd = tmp();
  const home = tmp();
  try {
    fn({ cwd, home });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe("loadConfig", () => {
  it("no files → DEFAULT_CONFIG host", () => {
    withTemp(({ cwd, home }) => {
      const config = loadConfig({ env: {}, cwd, homedir: home });
      assert.equal(config.ollama.host, DEFAULT_CONFIG.ollama.host);
    });
  });

  it("cwd/openagent.json is loaded", () => {
    withTemp(({ cwd, home }) => {
      write(
        path.join(cwd, "openagent.json"),
        JSON.stringify({
          provider: "ollama",
          ollama: { host: "http://cwd.example:11434" },
        }),
      );
      const config = loadConfig({ env: {}, cwd, homedir: home });
      assert.equal(config.ollama.host, "http://cwd.example:11434");
    });
  });

  it("OPENAGENT_CONFIG wins over cwd file", () => {
    withTemp(({ cwd, home }) => {
      write(
        path.join(cwd, "openagent.json"),
        JSON.stringify({ ollama: { host: "http://cwd.example:11434" } }),
      );
      const explicit = path.join(cwd, "explicit.json");
      write(
        explicit,
        JSON.stringify({ ollama: { host: "http://explicit.example:11434" } }),
      );
      const config = loadConfig({
        env: { OPENAGENT_CONFIG: explicit },
        cwd,
        homedir: home,
      });
      assert.equal(config.ollama.host, "http://explicit.example:11434");
    });
  });

  it("OPENAGENT_CONFIG set to a missing path → throws", () => {
    withTemp(({ cwd, home }) => {
      const missing = path.join(cwd, "missing.json");
      assert.throws(
        () =>
          loadConfig({
            env: { OPENAGENT_CONFIG: missing },
            cwd,
            homedir: home,
          }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /missing\.json/);
          return true;
        },
      );
    });
  });

  it("OPENAGENT_CONFIG file with host.docker.internal", () => {
    withTemp(({ cwd, home }) => {
      const dockerFile = path.join(cwd, "openagent.docker.json");
      write(
        dockerFile,
        JSON.stringify({
          provider: "ollama",
          ollama: { host: "http://host.docker.internal:11434" },
        }),
      );
      const config = loadConfig({
        env: { OPENAGENT_CONFIG: dockerFile },
        cwd,
        homedir: home,
      });
      assert.equal(config.ollama.host, "http://host.docker.internal:11434");
    });
  });

  it("~/.config/openagent/config.json when cwd has no file", () => {
    withTemp(({ cwd, home }) => {
      write(
        path.join(home, ".config", "openagent", "config.json"),
        JSON.stringify({ ollama: { host: "http://home.example:11434" } }),
      );
      const config = loadConfig({ env: {}, cwd, homedir: home });
      assert.equal(config.ollama.host, "http://home.example:11434");
    });
  });

  it("trailing slash on host is stripped", () => {
    withTemp(({ cwd, home }) => {
      write(
        path.join(cwd, "openagent.json"),
        JSON.stringify({ ollama: { host: "http://127.0.0.1:11434/" } }),
      );
      const config = loadConfig({ env: {}, cwd, homedir: home });
      assert.equal(config.ollama.host, "http://127.0.0.1:11434");
    });
  });

  it("invalid JSON → throw includes path", () => {
    withTemp(({ cwd, home }) => {
      const file = path.join(cwd, "openagent.json");
      write(file, "{");
      assert.throws(
        () => loadConfig({ env: {}, cwd, homedir: home }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
          return true;
        },
      );
    });
  });

  it(`"provider": "openai" → throw includes M1 only supports provider "ollama"`, () => {
    withTemp(({ cwd, home }) => {
      write(
        path.join(cwd, "openagent.json"),
        JSON.stringify({ provider: "openai" }),
      );
      assert.throws(
        () => loadConfig({ env: {}, cwd, homedir: home }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /M1 only supports provider "ollama"/);
          return true;
        },
      );
    });
  });

  it("missing model key is allowed", () => {
    withTemp(({ cwd, home }) => {
      write(
        path.join(cwd, "openagent.json"),
        JSON.stringify({
          provider: "ollama",
          ollama: { host: "http://127.0.0.1:11434" },
        }),
      );
      const config = loadConfig({ env: {}, cwd, homedir: home });
      assert.equal(config.model, undefined);
    });
  });

  it("defaulting does not return DEFAULT_CONFIG by reference", () => {
    withTemp(({ cwd, home }) => {
      const config = loadConfig({ env: {}, cwd, homedir: home });
      assert.notEqual(config, DEFAULT_CONFIG);
      assert.notEqual(config.ollama, DEFAULT_CONFIG.ollama);
    });
  });
});
