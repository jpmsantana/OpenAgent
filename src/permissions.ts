export type FileAllowKind = "write_file" | "str_replace" | "delete_file";

export type Grant =
  | { kind: FileAllowKind; path: string }
  | { kind: "run_command"; argv: string[] };

function fileKey(kind: FileAllowKind, path: string): string {
  return `file:${kind}:${path}`;
}

export class SessionAllowlist {
  #order: Grant[] = [];
  #files = new Map<string, Grant>();
  #commands = new Map<string, Grant>();

  allowsFile(kind: FileAllowKind, path: string): boolean {
    return this.#files.has(fileKey(kind, path));
  }

  allowsCommand(argv: string[]): boolean {
    return this.#commands.has(JSON.stringify(argv));
  }

  grantFile(kind: FileAllowKind, path: string): void {
    if (path === "") {
      return;
    }
    const key = fileKey(kind, path);
    if (this.#files.has(key)) {
      return;
    }
    const grant: Grant = { kind, path };
    this.#files.set(key, grant);
    this.#order.push(grant);
  }

  grantCommand(argv: string[]): void {
    if (argv.length === 0) {
      return;
    }
    const key = JSON.stringify(argv);
    if (this.#commands.has(key)) {
      return;
    }
    const grant: Grant = { kind: "run_command", argv: [...argv] };
    this.#commands.set(key, grant);
    this.#order.push(grant);
  }

  clear(): void {
    this.#order = [];
    this.#files.clear();
    this.#commands.clear();
  }

  list(): Grant[] {
    return this.#order.map((grant) =>
      grant.kind === "run_command"
        ? { kind: "run_command", argv: [...grant.argv] }
        : { kind: grant.kind, path: grant.path },
    );
  }
}
