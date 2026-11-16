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

M1 local Ollama chat still works. M2 adds **workspace file tools** in the current working directory. M3 adds a gated **`run_command`** tool (argv, no shell). M4 adds **`grep`**, a line window on **`read_file`**, **`str_replace`**, and **`delete_file`**. M5 adds **session permissions**: prompts are `[y/N/a]`. Reads and grep run immediately. Each write, replace, delete, and command waits for approval. M6 hardens that CLI (no new tools): `ollama.host` must be http(s), startup errors print `Error: …`, `run_command` gets an env allowlist and POSIX process-group kill, grep regexes time out, mutating tools refuse symlinks, and tool results sent back to the model are capped at 32768 characters. The goals above remain the product direction.

What works now:

- Interactive chat REPL against local Ollama
- Config selects the Ollama host; models come from Ollama, not listed in the config file
- `/model`, `/help`, `/clear`, `/allow`, `/allow clear`, `/exit`
- Ctrl-C during a turn cancels (including a running command) and returns to the prompt; Ctrl-C on an empty prompt quits
- Tools: `list_dir`, `read_file`, `grep`, `write_file`, `str_replace`, `delete_file`, `run_command` on the current working directory
- `grep` and reads run immediately
- `grep` skips `node_modules`, `.git`, and `dist`; caps at 50 matches
- Pathological grep regexes return `Error: regex timed out` instead of freezing the CLI. Patterns longer than 512 characters are rejected
- `read_file` may take `offset` (1-based line) and `limit`
- Tool results sent back to the model are capped at 32768 characters (`[truncated]`). `read_file` on disk is still 256 KiB
- Permission prompts are `[y/N/a]`
- `y` allows that one action
- `a` allows that **exact** write/replace/delete path or that **exact** command argv until the CLI exits
- A different path, different tool, or different argv still prompts
- `/allow` lists session grants; `/allow clear` drops them
- `/clear` clears conversation history and does **not** drop grants
- Grants are not written to config and do not survive process exit
- `str_replace` changes one unique literal substring
- `delete_file` removes a file (not a directory)
- `write_file`, `str_replace`, and `delete_file` refuse a symlink, including one that points at a file inside the workspace
- `run_command` takes `argv` (an array). There is no shell (`no sh -c`, no pipes)
- Commands time out after 30 seconds and capture at most 32 KiB of output
- `run_command` children get a small env allowlist (`PATH`, locale, temp, `NODE_ENV`, Windows process keys). They do not inherit tokens, `NODE_OPTIONS`, or `OPENAGENT_*`
- On POSIX, timeout / Ctrl-C / the output cap kill the process group (grandchildren). Windows kills only the direct child
- Path-style programs must stay inside the workspace; bare names (`npm`, `node`, `git`) use PATH
- Docker Compose so the CLI does not need a host Node install; the CLI process in Docker is not root

What does not work yet:

- Unrestricted shell
- Web navigation
- Search
- Providers other than Ollama
- Saved allowlists in the config file

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

`ollama.host` must be an `http://` or `https://` URL with no path, query, userinfo, or fragment. Invalid JSON, a rejected host, or `OPENAGENT_CONFIG` pointing at a missing file prints `Error: …` on stderr and exits 1.

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

Ollama still runs on the host. The container only provides Node. The Compose CLI runs as the `node` user (non-root). The workspace is the bind-mount at `/app`.

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
| `/clear` | Clear conversation history (does not drop session grants) |
| `/allow` | List session permission grants |
| `/allow clear` | Drop all session permission grants |
| `/model` | List models installed in Ollama |
| `/model <name>` | Switch model for this session |
| `/exit` | Quit |
| Ctrl-C | Cancel the current turn (kills an in-flight command); quit when the prompt is idle |

## Tools

| Tool | Action | Permission |
| --- | --- | --- |
| `list_dir` | List a directory (not recursive) | auto |
| `read_file` | Read a UTF-8 file (max 256 KiB; optional line window) | auto |
| `grep` | Regex search (skips `node_modules`, `.git`, `dist`; max 50 hits; overlong or pathological patterns error) | auto |
| `write_file` | Create or overwrite a UTF-8 file | `y` once, or `a` for this session (exact path) |
| `str_replace` | Replace one unique literal substring | `y` once, or `a` for this session (exact path) |
| `delete_file` | Delete a file | `y` once, or `a` for this session (exact path) |
| `run_command` | Run a program in cwd (`argv`, no shell) | `y` once, or `a` for this session (exact argv) |

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
> find MAX_TOOL_ROUNDS
tool: grep {"pattern":"MAX_TOOL_ROUNDS"}
src/agent.ts:7:export const MAX_TOOL_ROUNDS = 16;
> change that constant using a replace
tool: read_file {"path":"src/agent.ts","offset":6,"limit":3}
tool: str_replace {"path":"src/agent.ts","old_string":"export const MAX_TOOL_ROUNDS = 8;","new_string":"export const MAX_TOOL_ROUNDS = 16;"}
Allow replace in src/agent.ts? [y/N/a]
  --- old ---
  export const MAX_TOOL_ROUNDS = 8;
  --- new ---
  export const MAX_TOOL_ROUNDS = 16;
y
Replaced in src/agent.ts
> add a one-line comment at the top of LICENSE
tool: read_file {"path":"LICENSE"}
tool: write_file {"path":"LICENSE"}
Allow write to LICENSE (1085 bytes)? [y/N/a]
y
Wrote 1104 bytes to LICENSE
> run the tests
tool: run_command {"argv":["npm","test"]}
Allow command ["npm","test"]? [y/N/a]
a
exit 0
stdout:
ok
stderr:
> run the tests again
tool: run_command {"argv":["npm","test"]}
exit 0
stdout:
ok
stderr:
> /allow
Session allows:
  run_command ["npm","test"]
> /allow clear
Session allows cleared.
> /clear
Conversation cleared.
> /exit
```

A write you refuse:

```
Allow write to LICENSE (1085 bytes)? [y/N/a]
n
denied
```

A command you refuse:

```
Allow command ["npm","test"]? [y/N/a]
n
denied
```

A delete you refuse:

```
Allow delete tmp.txt? [y/N/a]
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
