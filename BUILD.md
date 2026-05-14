# Build Instructions

This guide covers local development and source builds for the BreezeType desktop app.

## Prerequisites

All platforms:

- Rust latest stable
- Bun
- Tauri prerequisites

macOS:

- Xcode Command Line Tools

```bash
xcode-select --install
```

Windows:

- Microsoft C++ Build Tools or Visual Studio with C++ desktop development tools
- WebView2 runtime

Linux:

```bash
# Ubuntu/Debian
sudo apt update
sudo apt install build-essential libasound2-dev pkg-config libssl-dev \
  libvulkan-dev vulkan-tools glslc libgtk-3-dev libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev librsvg2-dev patchelf cmake

# Fedora/RHEL
sudo dnf groupinstall "Development Tools"
sudo dnf install alsa-lib-devel pkgconf openssl-devel vulkan-devel \
  gtk3-devel webkit2gtk4.1-devel libappindicator-gtk3-devel librsvg2-devel cmake

# Arch Linux
sudo pacman -S base-devel alsa-lib pkgconf openssl vulkan-devel \
  gtk3 webkit2gtk-4.1 libappindicator-gtk3 librsvg cmake
```

## Setup

From the App repo root:

```bash
bun install
```

`bun install` prepares the local Senko diarization environment under ignored local directories. If you only need a quick frontend install and want to skip that step temporarily:

```bash
BREEZE_SKIP_SENKO_INSTALL=1 bun install
```

## Required Dev Model

Development builds need the Silero VAD model:

```bash
mkdir -p src-tauri/resources/models
curl -L -o src-tauri/resources/models/silero_vad_v4.onnx \
  https://blob.handy.computer/silero_vad_v4.onnx
```

Release builds bundle the intended model set, but generated model resources should stay uncommitted.

## Environment

Most local builds do not need environment variables. To override the managed BreezeType API or web URLs:

```bash
cp .env.example .env.local
```

The defaults preserve the same app behavior as distributed builds: local-first core features, with account and Pro workflows calling BreezeType's managed hosted API.

Leave `VITE_BREEZE_REQUIRE_FIRST_RUN_AUTH` unset for local and open-source builds so contributors can enter the app without signing in. Official production builds may set it to `true` to require auth during first-run onboarding.

Do not commit `.env.local`, provider API keys, signing credentials, local user data, transcripts, recordings, screenshots, generated model bundles, or temporary build output.

## Run In Development

```bash
bun run tauri dev
```

If macOS hits a CMake policy issue:

```bash
CMAKE_POLICY_VERSION_MINIMUM=3.5 bun run tauri dev
```

Frontend-only development:

```bash
bun run dev
```

## Build

Frontend build:

```bash
bun run build
```

Desktop bundle:

```bash
bun run tauri build
```

Release-like local bundle with bundled model assets:

```bash
bun run release:prepare
bun run tauri build
```

Official signed installers, notarization, updater artifacts, and publication are maintainer-only because they require private signing and updater credentials. See `docs/release-builds.md`.

## Checks

```bash
bun run build
bun run lint
cd src-tauri && cargo check
```
