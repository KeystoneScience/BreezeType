# Contributing to BreezeType

Thanks for helping make BreezeType better. This repository contains the real BreezeType desktop app: a local-first Tauri app for dictation, meeting capture, history, tasks, dictionary corrections, provider-based cleanup, and local MCP context.

## Project Boundary

BreezeType is open source at the desktop-app layer. The website and server codebases are intentionally outside this repository.

Account, Pro, sync, hosted sharing, support, telemetry, billing, and team workflows should keep calling BreezeType's managed API. Do not replace those flows with a different server assumption, bypass entitlement checks, or add committed credentials. Local development should work for core local features without managed API access.

## Getting Started

Prerequisites:

- Rust latest stable
- Bun
- Tauri platform prerequisites

Set up the repo:

```bash
bun install
```

Most contributors do not need environment variables. If you need local API or web URL overrides:

```bash
cp .env.example .env.local
```

Never commit `.env.local`, release signing material, provider API keys, local app data, transcripts, recordings, screenshots, generated model bundles, or temporary build output.

## Development

Common commands:

```bash
bun run tauri dev
bun run build
bun run lint
cd src-tauri && cargo check
```

If macOS hits a CMake policy issue:

```bash
CMAKE_POLICY_VERSION_MINIMUM=3.5 bun run tauri dev
```

For release-like local bundles with the intended local model assets:

```bash
bun run release:prepare
bun run tauri build
```

Official signing, notarization, updater signing, and publication are maintainer-only. Community PRs should not need release credentials or private deployment access.

## What To Work On

Good contributions are usually narrow and testable:

- Local dictation reliability and insertion behavior
- Audio device handling and permission guidance
- Local transcription, VAD, and model lifecycle improvements
- Meeting capture, summaries, exports, and local retention controls
- Tasks, history, dictionary, and MCP context improvements
- Accessibility, localization, and platform-specific polish
- Documentation that helps contributors build or understand the app

For larger features, open an issue or discussion first so the implementation can stay aligned with BreezeType's local-first product direction.

## Pull Request Checklist

Before opening a PR:

- Keep the change scoped to the App repo.
- Preserve existing Pro and managed API behavior unless the PR is explicitly about that boundary.
- Run the relevant checks:

  ```bash
  bun run build
  bun run lint
  cd src-tauri && cargo check
  ```

- Add screenshots or screen recordings for UI changes when useful.
- Document any new env vars, permissions, or data flows.
- Confirm no credentials, local user data, recordings, transcripts, screenshots, generated models, or temporary outputs are included.

## Code Style

Rust:

- Use `cargo fmt`.
- Prefer explicit errors over `unwrap` in production paths.
- Keep platform-specific behavior behind clear `cfg` gates.

TypeScript and React:

- Keep types explicit.
- Follow existing component and store patterns.
- Keep UI changes consistent with the current BreezeType visual system.

General:

- Favor small, readable changes.
- Add comments only where they clarify non-obvious behavior.
- Keep local-first behavior and user data boundaries clear.

## License

By contributing, you agree that your contributions are licensed under the repository license. See `LICENSE`.
