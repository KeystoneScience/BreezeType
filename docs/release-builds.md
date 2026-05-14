# BreezeType Release Builds

This document defines the public release boundary for the open-source BreezeType desktop App repo.

The source tree can build the same desktop app that users install. Official BreezeType installers, auto-update artifacts, notarization, updater signatures, and publication are maintainer-only because they require private signing credentials and updater key material.

The source repo is `KeystoneScience/breeze`. Public signed release artifacts are published separately to `KeystoneScience/breeze-releases`.

## Contributor Builds

Contributors can build and run the app locally without private release credentials:

```bash
bun install
bun run tauri dev
bun run build
bun run tauri build
```

For a release-like local bundle that includes the intended local model resources:

```bash
bun run release:prepare
bun run tauri build
```

Generated resources under `src-tauri/resources/`, local virtual environments, `tmp/`, `output/`, and platform build outputs are local artifacts and should not be committed.

## Managed Service Boundary

The public App repo intentionally keeps the same Pro/server behavior as distributed BreezeType builds:

- Core dictation, meetings, history, tasks, dictionary corrections, and local MCP context are local-first.
- Account, Pro, sync, hosted sharing, support, telemetry, billing, and team workflows call BreezeType's managed hosted API when used.
- The private website and server repos are not required for local App development and are not part of this source tree.

## Official Releases

Official BreezeType releases are produced by maintainers from a controlled environment. Public contributors do not need Apple Developer credentials, Windows signing credentials, updater private keys, GitHub release tokens, or private server credentials.

Official releases should continue to ship a signed installer for first install and signed Tauri updater artifacts for in-app updates. On macOS, a full release includes:

- `BreezeType.dmg`
- `BreezeType.app.tar.gz`
- `BreezeType.app.tar.gz.sig`
- `latest.json`

Those assets must come from the same final app bundle so manual installs and in-app updates match.

## Auto-Updater

The public updater endpoint and public verification key live in `src-tauri/tauri.conf.json` under `plugins.updater`.

Current public updater metadata is served from:

```text
https://github.com/KeystoneScience/breeze-releases/releases/latest/download/latest.json
```

The updater private key, signing passwords, notarization credentials, and release publication tokens are intentionally not documented here and must never be committed. If you are not working in a maintainer-controlled release environment, do not run publish commands.

## Release Visuals

The committed DMG background in `src-tauri/dmg/BreezeTypeDmgBackground.png` is part of the installer packaging surface. GitHub README screenshots, generated hero images, and social-preview candidates should be committed separately under `.github/assets/` after they are reviewed and sanitized.

Do not reuse release scratch images, local `tmp/` screenshots, or `output/` captures as durable GitHub visuals.

## Maintainer-Only Script

The repo includes release scripts for maintainers. In a correctly configured maintainer environment, the guarded path is:

```bash
bun run release:mac -- --check
bun run release:mac -- --publish
```

Do not add real credentials to `.env.example`, committed docs, committed config, CI logs, issue comments, or pull requests. Keep local credentials in ignored files or trusted secret stores only.

## Common Local Build Notes

- A local `bun run tauri build` may produce unsigned or locally signed artifacts depending on your platform setup.
- A local build is not an official BreezeType release unless it is signed, notarized where required, updater-signed, published by maintainers, and verified through the public download/update surfaces.
- If a build fails because bundled model or Senko assets are missing, run `bun run release:prepare` and rebuild.
- If a build fails because signing credentials are missing, you are probably attempting an official release path from a non-maintainer environment.
