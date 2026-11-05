import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { chatStream, listModels, OllamaError } from "./ollama.ts";

async function withServer(
  handler: http.RequestListener,
  fn: (host: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

async function unusedHost(): Promise<string> {
  const server = http.createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const host = `http://127.0.0.1:${address.port}`;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  return host;
}

describe("listModels", () => {
  it(`parses {"models":[{"name":"a"},{"name":"b"}]}`, async () => {
    await withServer((req, res) => {
      assert.equal(req.method, "GET");
      assert.equal(req.url, "/api/tags");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "a" }, { name: "b" }] }));
    }, async (host) => {
      assert.deepEqual(await listModels(host), ["a", "b"]);
    });
  });

  it("connection refused → OllamaError matching /Cannot reach Ollama/", async () => {
    const host = await unusedHost();
    await assert.rejects(() => listModels(host), (err: unknown) => {
      assert.ok(err instanceof OllamaError);
      assert.match(err.message, /Cannot reach Ollama/);
      return true;
    });
  });

  it("HTTP 500 → OllamaError with status === 500", async () => {
    await withServer((_req, res) => {
      res.writeHead(500);
      res.end("nope");
    }, async (host) => {
      await assert.rejects(() => listModels(host), (err: unknown) => {
        assert.ok(err instanceof OllamaError);
        assert.equal(err.status, 500);
        return true;
      });
    });
  });
});

describe("chatStream", () => {
  it("yields concatenated Hello from NDJSON chunks plus done", async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write('{"message":{"role":"assistant","content":"Hel"}}\n');
      res.write('{"message":{"role":"assistant","content":"lo"}}\n');
      res.write('{"done":true}\n');
      res.end();
    }, async (host) => {
      const chunks: string[] = [];
      for await (const chunk of chatStream(host, {
        model: "m",
        messages: [{ role: "user", content: "hi" }],
      })) {
        chunks.push(chunk);
      }
      assert.equal(chunks.join(""), "Hello");
    });
  });

  it("already-aborted signal rejects with AbortError", async () => {
    await withServer((_req, res) => {
      res.writeHead(200);
      res.end();
    }, async (host) => {
      const signal = AbortSignal.abort();
      await assert.rejects(
        () =>
          chatStream(host, {
            model: "m",
            messages: [],
            signal,
          }).next(),
        (err: unknown) => {
          assert.equal((err as Error).name, "AbortError");
          assert.equal(err instanceof OllamaError, false);
          return true;
        },
      );
    });
  });

  it("HTTP 404 → OllamaError", async () => {
    await withServer((_req, res) => {
      res.writeHead(404);
      res.end("missing model");
    }, async (host) => {
      await assert.rejects(
        () =>
          chatStream(host, { model: "nope", messages: [] }).next(),
        (err: unknown) => {
          assert.ok(err instanceof OllamaError);
          assert.equal(err.status, 404);
          return true;
        },
      );
    });
  });
});
