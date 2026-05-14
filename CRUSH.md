# Development Commands

Use [AGENTS.md](AGENTS.md) and [README.md](README.md) for the full BreezeType desktop App workflow.

```bash
bun install
mkdir -p src-tauri/resources/models
curl -L -o src-tauri/resources/models/silero_vad_v4.onnx \
  https://blob.handy.computer/silero_vad_v4.onnx
bun run tauri dev
```

Validation:

```bash
bun run build
bun run lint
cd src-tauri && cargo check
```

Keep Pro/server calls intact and do not commit local secrets or generated artifacts.
