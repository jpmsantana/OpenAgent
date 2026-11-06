#!/usr/bin/env node

import { loadConfig } from "./config.js";
import { chatStream, listModels } from "./ollama.js";
import { runRepl } from "./repl.js";
import { createReadTools } from "./tools.js";

export function usage(): string {
  return `openagent — local chat CLI

Usage:
  openagent          Start the chat REPL
  openagent --help   Show this help
`;
}

export async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(usage());
    return 0;
  }

  try {
    const config = loadConfig();
    await runRepl({
      input: process.stdin,
      output: process.stdout,
      host: config.ollama.host,
      initialModel: config.model,
      listModels,
      chatStream,
      workspaceRoot: process.cwd(),
      tools: createReadTools(),
    });
    return 0;
  } catch {
    return 1;
  }
}

process.exit(await main(process.argv.slice(2)));
