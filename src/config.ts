import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Config = {
  provider: "ollama";
  ollama: {
    host: string;
  };
  /** Optional. Session default; may be omitted. Not a list of allowed models. */
  model?: string;
};

export const DEFAULT_CONFIG: Config = {
  provider: "ollama",
  ollama: { host: "http://127.0.0.1:11434" },
};

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function parseConfigFile(absPath: string): Config {
  const text = fs.readFileSync(absPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${absPath}: ${message}`, { cause: err });
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${absPath}: config must be a JSON object`);
  }

  const data = parsed as Record<string, unknown>;
  if (data.provider !== undefined && data.provider !== "ollama") {
    throw new Error(`Only provider "ollama" is supported`);
  }

  let host = DEFAULT_CONFIG.ollama.host;
  if (data.ollama !== undefined) {
    if (
      data.ollama === null ||
      typeof data.ollama !== "object" ||
      Array.isArray(data.ollama)
    ) {
      throw new Error(`${absPath}: ollama must be an object`);
    }
    const ollama = data.ollama as Record<string, unknown>;
    if (typeof ollama.host === "string" && ollama.host.length > 0) {
      host = ollama.host;
    }
  }

  const config: Config = {
    provider: "ollama",
    ollama: { host: normalizeOllamaHost(host, absPath) },
  };
  if (typeof data.model === "string" && data.model.length > 0) {
    config.model = data.model;
  }
  return config;
}

export function loadConfig(opts?: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  homedir?: string;
}): Config {
  const env = opts?.env ?? process.env;
  const cwd = opts?.cwd ?? process.cwd();
  const homedir = opts?.homedir ?? os.homedir();

  const explicit = env.OPENAGENT_CONFIG;
  if (explicit) {
    const absPath = path.resolve(cwd, explicit);
    if (!isFile(absPath)) {
      throw new Error(`Config file not found: ${absPath}`);
    }
    return parseConfigFile(absPath);
  }

  const cwdFile = path.join(cwd, "openagent.json");
  if (isFile(cwdFile)) {
    return parseConfigFile(cwdFile);
  }

  const homeFile = path.join(homedir, ".config", "openagent", "config.json");
  if (isFile(homeFile)) {
    return parseConfigFile(homeFile);
  }

  return {
    provider: DEFAULT_CONFIG.provider,
    ollama: { host: normalizeOllamaHost(DEFAULT_CONFIG.ollama.host) },
  };
}

function invalidOllamaHost(source?: string): Error {
  const message = "ollama.host must be an http(s) URL";
  return new Error(source === undefined ? message : `${source}: ${message}`);
}

function normalizeOllamaHost(host: string, source?: string): string {
  const trimmed = host.endsWith("/") ? host.slice(0, -1) : host;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw invalidOllamaHost(source);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw invalidOllamaHost(source);
  }
  if (url.username !== "" || url.password !== "") {
    throw invalidOllamaHost(source);
  }
  if (url.search !== "" || url.hash !== "") {
    throw invalidOllamaHost(source);
  }
  if (url.pathname !== "" && url.pathname !== "/") {
    throw invalidOllamaHost(source);
  }
  return `${url.protocol}//${url.host}`;
}
