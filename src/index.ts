#!/usr/bin/env node

export function usage(): string {
  return `openagent — local chat CLI

Usage:
  openagent          Start the chat REPL
  openagent --help   Show this help
`;
}

export function main(argv: string[]): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(usage());
    return 0;
  }

  process.stdout.write("OpenAgent CLI stub. Chat REPL is not implemented yet.\n");
  return 0;
}

process.exit(main(process.argv.slice(2)));
