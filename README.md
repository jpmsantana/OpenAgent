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

## Stack

TypeScript on Node.js 22+. Docker Compose is the OS-agnostic way to run the CLI when the host Node toolchain is missing or broken. Ollama stays on the host; the image only provides Node.

## Status

The repo has a TypeScript CLI that chats with local Ollama. `/model` lists and selects a session model from Ollama. `/exit` is still a placeholder.

## Development

Host Node 22+:

```
npm install
npm run lint
npm test
npm run build
npm start
```

Pull requests run **lint** and **test** in GitHub Actions. Both must pass.

Docker (no host Node required):

```
docker compose build
docker compose run --rm openagent
docker compose run --rm -T openagent npm run lint
docker compose run --rm -T openagent npm test
```

`npm start` / `docker compose run --rm openagent` enter the chat REPL (Ollama must be running on the host).

## License

[MIT](LICENSE)
