# Agent notes

- Node.js >= 22, npm, ESM TypeScript. No production dependencies unless an issue explicitly adds one.
- OS-agnostic run path is Docker Compose. If host `npm` is missing or broken, use `docker compose` — do not add extra host toolchains or OS-specific install docs to “make npm work”.
- Ollama stays on the host. Do not put Ollama inside the CLI image.
- One GitHub issue per PR. Follow that issue’s file list and acceptance criteria. Do not implement work from other open issues in the same PR.
- `npm test` and `npm run build` must pass on the host or via:

```
docker compose run --rm -T openagent npm test
docker compose run --rm -T openagent npm run build
```

- When you change behavior a user would see (how to install, run, configure, or which commands exist), update `README.md` in the same PR.
