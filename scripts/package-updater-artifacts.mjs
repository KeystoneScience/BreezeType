#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tauriConfig = JSON.parse(
  readFileSync(join(repoRoot, "src-tauri", "tauri.conf.json"), "utf8"),
);

const version = tauriConfig.version;
if (!version) {
  throw new Error("src-tauri/tauri.conf.json is missing version.");
}

const appPath = resolve(
  repoRoot,
  getArgValue("--app") ??
    "src-tauri/target/release/bundle/macos/BreezeType.app",
);
const outDir = resolve(
  repoRoot,
  getArgValue("--out-dir") ?? "src-tauri/target/release/bundle/macos",
);
const repo = getArgValue("--repo") ?? process.env.GITHUB_REPO;
const privateKeyPath = resolve(
  repoRoot,
  getArgValue("--private-key-path") ?? "../.secrets/tauri/breeze-updater.key",
);
const platform = getArgValue("--platform") ?? defaultPlatform();
normalizeUpdaterKeyPasswordEnv();

if (!repo) {
  throw new Error("Pass --repo owner/name or set GITHUB_REPO.");
}
if (!existsSync(appPath)) {
  throw new Error(`Missing app bundle: ${appPath}`);
}
if (!existsSync(privateKeyPath)) {
  throw new Error(`Missing updater private key: ${privateKeyPath}`);
}

await mkdir(outDir, { recursive: true });

const archivePath = join(outDir, "BreezeType.app.tar.gz");
const signaturePath = `${archivePath}.sig`;
const latestPath = resolve(
  repoRoot,
  getArgValue("--latest") ?? join(outDir, "..", "latest.json"),
);

await rm(archivePath, { force: true });
await rm(signaturePath, { force: true });

run("tar", ["-czf", archivePath, "-C", dirname(appPath), basename(appPath)]);

const signer = spawnSync(
  "bunx",
  ["tauri", "signer", "sign", "-f", privateKeyPath, archivePath],
  {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
  },
);

if (signer.error) throw signer.error;
if (signer.status !== 0) {
  process.stderr.write(signer.stderr);
  process.stdout.write(signer.stdout);
  throw new Error(
    "Failed to sign updater archive. Set TAURI_SIGNING_PRIVATE_KEY_PASSWORD if the updater key is encrypted. The legacy TAURI_PRIVATE_KEY_PASSWORD alias is also accepted by release-macos.mjs.",
  );
}

const signature = extractSignature(signer.stdout);
writeFileSync(signaturePath, `${signature}\n`);

const latest = {
  version,
  notes: process.env.UPDATE_NOTES ?? "",
  pub_date: new Date().toISOString(),
  platforms: {
    [platform]: {
      url: `https://github.com/${repo}/releases/download/v${version}/${basename(archivePath)}`,
      signature,
    },
  },
};

await mkdir(dirname(latestPath), { recursive: true });
writeFileSync(latestPath, JSON.stringify(latest, null, 2) + "\n");

console.log(`Wrote ${archivePath}`);
console.log(`Wrote ${signaturePath}`);
console.log(`Wrote ${latestPath}`);

function getArgValue(name) {
  const index = args.findIndex((arg) => arg === name);
  return index === -1 ? undefined : args[index + 1];
}

function normalizeUpdaterKeyPasswordEnv() {
  const password =
    process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??
    process.env.TAURI_PRIVATE_KEY_PASSWORD;
  if (!password) return;
  process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = password;
  process.env.TAURI_PRIVATE_KEY_PASSWORD = password;
}

function defaultPlatform() {
  if (process.platform !== "darwin") {
    throw new Error("Default updater platform is only defined for macOS.");
  }
  return process.arch === "arm64" ? "darwin-aarch64" : "darwin-x86_64";
}

function extractSignature(stdout) {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const labeled = line.match(/^Signature:\s*(.+)$/i);
    if (labeled) return labeled[1].trim();
  }

  const raw = lines.find((line) => /^[A-Za-z0-9+/=]+$/.test(line));
  if (raw) return raw;

  throw new Error(
    "Could not parse updater signature from Tauri signer output.",
  );
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Command failed: ${[command, ...commandArgs].join(" ")}`);
  }
}
