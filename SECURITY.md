# Security Policy

BreezeType is a local-first desktop app with optional managed account and Pro features. Please help keep both sides of that boundary clear.

## Reporting A Vulnerability

Please do not open a public issue for security vulnerabilities.

Use GitHub private vulnerability reporting if it is enabled for the repository. If it is not available, email `team@breezetype.com` with:

- A short description of the issue
- Affected platform and app version or commit
- Reproduction steps or proof-of-concept details
- Only sanitized logs or screenshots that do not contain private user data or credentials

We will acknowledge reports as quickly as practical and coordinate next steps before public disclosure.

## Sensitive Data

Never commit:

- `.env`, `.env.local`, or other local secret files
- Apple, Windows, Tauri updater, GitHub, provider, or managed API credentials
- Private keys, signing certificates, provisioning profiles, keychains, or notarization material
- Local app data, SQLite databases, transcripts, recordings, screenshots, exported meeting content, or debug bundles
- Generated model bundles, local virtual environments, `tmp/`, `output/`, or platform build artifacts

Use `.env.example` only for safe defaults and documented local overrides.

## Product Boundary

The open-source repo contains the BreezeType desktop app. Pro, account, sync, hosted sharing, support, telemetry, billing, and team workflows intentionally call BreezeType's managed hosted API when used.

Do not bypass entitlement checks, hard-code credentials, document hosted-service internals, or add alternate server assumptions unless the change is explicitly scoped and reviewed.

## Local-First Data Handling

Core dictation, local transcription, history, meetings, tasks, dictionary corrections, and local MCP context are designed to work locally. Optional features can send data outside the device, including:

- Account, Pro, sync, sharing, support, or telemetry calls to BreezeType's managed API
- User-configured post-processing providers such as local LLMs or external model APIs
- Export or sharing actions initiated by the user

Changes that introduce new data flows should document what leaves the machine, when it happens, and which setting or user action controls it.

## Release Security

Official installers and updater artifacts are signed by maintainers. The public updater key and endpoint are committed in Tauri config; updater private keys and signing credentials are not.

If you are not in a maintainer-controlled release environment, do not run publish commands or add release credentials to local examples, docs, CI config, or pull requests.
