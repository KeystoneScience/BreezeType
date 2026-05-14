# Open Source Readiness Checklist

This checklist tracks the App-only public release boundary. The Website and Server repos stay outside this desktop client repository.

## Must Finish Before Making The App Repo Public

- [ ] Commit the `tmp/` and `output/` deletions so generated media and screenshots are no longer in the tip of the repo.
- [ ] Rewrite git history to remove previously committed `tmp/`, `output/`, audio, transcript, screenshot, and other generated artifacts.
- [ ] Re-run sensitive-file and credential scanning after the history rewrite.
- [ ] Confirm `.env.local`, `.secrets/`, signing keys, updater private keys, provisioning profiles, and generated model/runtime directories are ignored.
- [ ] Confirm Pro features still call the hosted BreezeType API and local-only features still work without sign-in.
- [ ] Review bundled third-party binaries/models and keep their licenses with the shipped assets.
- [ ] Decide final copyright, license, and trademark language before public launch.

## Public Boundary

Open:

- Desktop App source
- local dictation
- local meeting capture and history
- local tasks, dictionary, and MCP context
- optional local/external post-processing provider integrations

Private:

- Website source
- Server source
- billing
- hosted account/team management
- production deployment infrastructure
- release signing material

## Task 4 Source And History Scan

Last scan: 2026-05-13 in the App repo.

Commands used:

```bash
git status --short
git ls-files
git grep -n -I -E '<sensitive-file and credential patterns>'
git log --all --name-only
git log --all --stat -- tmp output
git log --all --oneline -G '<sensitive-file and credential patterns>'
git rev-list --objects --all | git cat-file --batch-check='%(objecttype) %(objectname) %(objectsize) %(rest)'
git check-ignore -v .env.local .env .secrets/foo.pem secrets/foo.key private/foo.p8 tmp/foo.wav output/foo.png dist/foo.js .venv-senko/bin/python .venv-soprano/bin/python
```

Findings:

- No tracked high-confidence credential values were found by exact-format scans.
- The current worktree already deletes tracked `tmp/` and `output/` artifacts, but those paths remain in `HEAD` until the deletion is committed.
- Git history still contains committed local artifacts under `tmp/` and `output/`, including a 40 MB meeting-audio WAV, multiple 4.7-6.7 MB UI screenshots, small transcript/diarization JSON files, and `tmp/agent-research/*` gitlink entries.
- Release workflows require maintainer-controlled GitHub Actions credentials, but no credential values are committed.
- Current source keeps the intended public Pro boundary: the desktop app defaults to `https://api.breezetype.com`, while Pro/auth/sync/share features call the hosted BreezeType API.
- `App/.env.local`, `.env`, `.secrets/`, private key/cert patterns, `tmp/`, `output/`, `dist/`, `.venv-senko/`, and `.venv-soprano/` are ignored by the current `.gitignore`.

Before public launch:

- [ ] Commit the current tracked `tmp/` and `output/` deletions.
- [ ] Rewrite history to remove `tmp/`, `output/`, and old generated media artifacts.
- [ ] Re-run sensitive-file and credential scanning after history rewrite, ideally with `gitleaks` or `trufflehog` plus the exact-pattern `git grep` checks above.
- [ ] Decide whether maintainer release workflows should stay enabled in the public repo or move to private release automation.
