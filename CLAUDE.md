# CLAUDE.md

Use [AGENTS.md](AGENTS.md) as the canonical coding-agent guide for this repository.

This repo contains the BreezeType desktop App only. Preserve the same desktop app behavior: local-first dictation, meetings, history, tasks, dictionary corrections, and MCP context should work without sign-in, while Pro/account/sync/share/support/telemetry flows continue to call BreezeType's hosted API.

Common checks:

```bash
bun run build
bun run lint
cd src-tauri && cargo check
```

Do not commit `.env.local`, local recordings, transcripts, screenshots, generated `tmp/` or `output/` artifacts, bundled model/runtime outputs, signing credentials, updater private keys, or release credentials.
