#!/usr/bin/env bun

import { chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const installScript = join(rootDir, "scripts", "install-senko.sh");

if (process.env.BREEZE_SKIP_SENKO_INSTALL === "1") {
  console.log("Skipping Senko install (BREEZE_SKIP_SENKO_INSTALL=1).");
  process.exit(0);
}

if (!existsSync(installScript)) {
  console.error(`Missing Senko installer script: ${installScript}`);
  process.exit(1);
}

const args = process.platform === "win32" ? [installScript] : [];
const command = process.platform === "win32" ? process.env.BASH || "bash" : installScript;

if (process.platform !== "win32") {
  try {
    chmodSync(installScript, 0o755);
  } catch {
    // Let the script execution below report the actionable error.
  }
}

const result = spawnSync(command, args, {
  cwd: rootDir,
  env: process.env,
  stdio: "inherit",
});

if (result.error) {
  console.error(`Failed to run Senko installer: ${result.error.message}`);
  if (process.platform === "win32") {
    console.error("Install Git Bash, set BASH to bash.exe, or set BREEZE_SKIP_SENKO_INSTALL=1.");
  }
  process.exit(1);
}

process.exit(result.status ?? 1);
