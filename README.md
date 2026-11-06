# OpenAgent

OpenAgent is an open-source agent that can browse the web, search, write programs, run commands, and check the results — under explicit permissions and human supervision.

## Goals

- **Web navigation** — open pages, follow links, extract information, and act on what it finds.
- **Search** — look things up and fold the results into the current task.
- **Programming** — write, edit, and reason about code in a real workspace.
- **Command execution** — run shell commands and inspect their output.
- **Verification** — check that work actually succeeded before moving on.
- **Permissions** — gated access to tools, files, network, and side effects.
- **Human supervision** — a person stays in the loop for approval, course-correction, and takeover.

## Status

M1 local Ollama chat still works. M2 adds **workspace file tools** in the current working directory. Reads run immediately. Each write waits for `y/N`. The goals above remain the product direction.

What works now:

- Interactive chat REPL against local Ollama
- Config selects the Ollama host; models come from Ollama, not listed in the config file
- `/model`, `/help`, `/clear`, `/exit`
- Ctrl-C during a turn cancels and returns to the prompt; Ctrl-C on an empty prompt quits
- Tools: `list_dir`, `read_file`, `write_file` on the current working directory
- `write_file` requires typing `y` (not `yes`)
- Docker Compose so the CLI does not need a host Node install

What does not work yet:

- Shell / command execution
- Web navigation
- Search
- Providers other than Ollama

## Prerequisites

- **Ollama** running on the host (`ollama serve`) and a **tool-capable** model, for example `ollama pull qwen2.5-coder:7b`
- **Either** Node.js 22+ **or** Docker with Compose V2 (`docker compose`). Use Docker when Node is missing or broken.

## Workspace

The workspace is the process current working directory. Paths outside cwd are rejected.

- **Host:** `cd` into the project you want edited, then `npm start` (from the OpenAgent install / this repo). Starting from this repo uses this tree as the workspace.
- **Docker:** Compose bind-mounts this repo at `/app`, so tools edit the OpenAgent tree unless you change the volumes.

## Configure

Search order:

1. `$OPENAGENT_CONFIG`
2. `./openagent.json`
3. `~/.config/openagent/config.json`

If no file exists, the host default is `http://127.0.0.1:11434`.

For a host Node run, copy `openagent.json.example` to `openagent.json` or to `~/.config/openagent/config.json`:

```json
{
  "provider": "ollama",
  "ollama": {
    "host": "http://127.0.0.1:11434"
  },
  "model": "qwen2.5-coder:7b"
}
```

`model` is an optional session default. The config does **not** enumerate models; `/model` asks Ollama.

Docker: `compose.yaml` sets `OPENAGENT_CONFIG=/app/openagent.docker.json` with host `http://host.docker.internal:11434`. Do not use `127.0.0.1` from inside the container. Ollama stays on the host.

## Run (host Node)

```
npm install
npm start
```

## Run (Docker — OS-agnostic)

Ollama still runs on the host. The container only provides Node.

```
docker compose build
docker compose run --rm openagent
```

Tests:

```
docker compose run --rm -T openagent npm test
```

The Compose service is interactive (`stdin_open` / `tty`). Use `-T` only for non-interactive commands (CI, tests).

## Commands

| Command | Action |
| --- | --- |
| `/help` | List commands |
| `/clear` | Clear conversation history |
| `/model` | List models installed in Ollama |
| `/model <name>` | Switch model for this session |
| `/exit` | Quit |
| Ctrl-C | Cancel the current turn; quit when the prompt is idle |

## Tools

| Tool | Action | Permission |
| --- | --- | --- |
| `list_dir` | List a directory (not recursive) | auto |
| `read_file` | Read a UTF-8 file (max 256 KiB) | auto |
| `write_file` | Create or overwrite a UTF-8 file | `y/N` each time |

## Example

```
$ npm start
OpenAgent  (ollama / qwen2.5-coder:7b)
Workspace: /path/to/project
Type /help for commands, /exit to quit.
> list the files in src and summarize repl.ts
tool: list_dir {"path":"src"}
tool: read_file {"path":"src/repl.ts"}
repl.ts is the readline loop: it loads models, streams chat, and dispatches slash commands...
> add a one-line comment at the top of LICENSE
tool: read_file {"path":"LICENSE"}
tool: write_file {"path":"LICENSE"}
Allow write to LICENSE (1085 bytes)? [y/N]
y
Wrote 1104 bytes to LICENSE
> /clear
Conversation cleared.
> /exit
```

A write you refuse:

```
Allow write to LICENSE (1085 bytes)? [y/N]
n
denied
```

## Develop

```
npm test
npm run lint
npm run build
```

or:

```
docker compose run --rm -T openagent npm test
docker compose run --rm -T openagent npm run lint
docker compose run --rm -T openagent npm run build
```

Pull requests run **lint** and **test** in GitHub Actions. Both must pass. Agent and PR rules: [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)
