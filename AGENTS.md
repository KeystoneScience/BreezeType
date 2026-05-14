# AGENTS.md

This file gives coding agents repo-specific guidance for the BreezeType desktop App.

## Scope

- Work in this App repo only unless the user explicitly asks for another surface.
- Do not edit sibling `Website/` or `Server/` repos from an App-scoped task.
- Preserve the same desktop app behavior. This is not a community fork or a stripped-down build.
- Keep Pro, account, sync, hosted sharing, support, telemetry, billing, and team workflows pointed at BreezeType's managed API unless the task explicitly changes that boundary.
- Keep local-first behavior central: core dictation, meetings, history, tasks, dictionary corrections, and local MCP context should work without private server credentials.

## Development Commands

Prerequisites:

- Rust latest stable
- Bun
- Tauri platform prerequisites

Common commands:

```bash
bun install
bun run tauri dev
bun run build
bun run lint
cd src-tauri && cargo check
```

If macOS hits a CMake policy issue:

```bash
CMAKE_POLICY_VERSION_MINIMUM=3.5 bun run tauri dev
```

Required VAD model for development:

```bash
mkdir -p src-tauri/resources/models
curl -L -o src-tauri/resources/models/silero_vad_v4.onnx \
  https://blob.handy.computer/silero_vad_v4.onnx
```

Optional local env overrides:

```bash
cp .env.example .env.local
```

Do not commit `.env.local`, provider API keys, signing credentials, local app data, recordings, transcripts, screenshots, generated model bundles, or temporary output.

## Verification

For most App changes, run:

```bash
bun run build
bun run lint
```

When Rust, Tauri commands, permissions, audio, transcription, meetings, MCP, updater config, or bundled resources change, also run:

```bash
cd src-tauri && cargo check
```

When runtime behavior is relevant, launch:

```bash
bun run tauri dev
```

## Architecture

Backend:

- `src-tauri/src/lib.rs` wires the Tauri app, plugins, tray, windows, and managers.
- `src-tauri/src/managers/` owns audio, models, transcription, history, meetings, tasks, local LLM, MCP-facing data, and related state.
- `src-tauri/src/commands/` exposes Tauri commands to the frontend.
- `src-tauri/src/audio_toolkit/` contains low-level device, recording, resampling, and VAD pieces.

Frontend:

- `src/App.tsx` and `src/components/` implement the desktop UI.
- `src/stores/` contains client-side state for settings, auth, tasks, history, and feature flows.
- `src/lib/serverApi.ts` defines the managed BreezeType API and web URL defaults.
- `src/bindings.ts` is the generated command surface between frontend and Rust.

Important context:

- Transcription is Parakeet-based, not Whisper-based.
- Some older internal names may still contain `handy_*`; avoid broad renames unless the task is specifically about naming cleanup.
- macOS permissions matter for dictation, insertion, meeting capture, and app context features.
- The hidden local MCP surface is read-oriented and should not leak private hosted-server assumptions.

## Release Boundary

Public contributors can build local unsigned or locally signed bundles with:

```bash
bun run tauri build
```

Official BreezeType release publishing is maintainer-only because it uses private signing credentials, notarization credentials, updater signing keys, and release publication permissions. Do not add those secrets to docs, examples, source, or committed config.

For the public release boundary, read `docs/release-builds.md`. Release scripts may exist in this repo, but running `--publish` is only appropriate in a maintainer-controlled environment.

## Editing Guidance

- Prefer narrow changes that match existing patterns.
- Keep docs and examples public-safe.
- Do not rewrite release scripts, updater config, auth/server behavior, or product boundaries unless the user explicitly asks.
- If you encounter unrelated dirty worktree changes, leave them alone.
