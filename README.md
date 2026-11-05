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

M1 is **local Ollama chat only**. The goals above are the product direction; they are not implemented yet.

What works now:

- Interactive chat REPL against local Ollama
- Config selects the Ollama host; models are discovered from Ollama, not listed in the config file
- `/model`, `/help`, `/exit`, and Ctrl-C
- Docker Compose so the CLI does not need a host Node install

## Prerequisites

- **Ollama** running on the host (`ollama serve`) and at least one pulled model, for example `ollama pull qwen2.5-coder:7b`
- **Either** Node.js 22+ **or** Docker with Compose V2 (`docker compose`). Use Docker when Node is missing or broken.

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
| `/model` | List models installed in Ollama |
| `/model <name>` | Switch model for this session |
| `/exit` | Quit (Ctrl-C does the same) |

## Develop

```
npm test
npm run build
```

or:

```
docker compose run --rm -T openagent npm test
docker compose run --rm -T openagent npm run build
```

Pull requests run **lint** and **test** in GitHub Actions. Both must pass. Agent and PR rules: [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)
