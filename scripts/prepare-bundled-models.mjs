#!/usr/bin/env node
import { createWriteStream, existsSync } from "node:fs";
import {
  cp,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join, relative as pathRelative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modelsDir = join(repoRoot, "src-tauri", "resources", "models");
const workDir = join(repoRoot, "src-tauri", "target", "bundled-models");

const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");
const pruneOnly = args.has("--prune-only");

const requiredAssets = [
  {
    id: "silero-vad",
    type: "file",
    url: "https://blob.handy.computer/silero_vad_v4.onnx",
    path: join(modelsDir, "silero_vad_v4.onnx"),
    minBytes: 1_000_000,
  },
  {
    id: "parakeet-tdt-0.6b-v3-int8",
    type: "tarDirectory",
    url: "https://blob.handy.computer/parakeet-v3-int8.tar.gz",
    path: join(modelsDir, "parakeet-tdt-0.6b-v3-int8"),
    directoryName: "parakeet-tdt-0.6b-v3-int8",
    expectedFiles: [
      "config.json",
      "decoder_joint-model.int8.onnx",
      "encoder-model.int8.onnx",
      "nemo128.onnx",
      "vocab.txt",
    ],
  },
  {
    id: "qwen3.5-0.8b-q8_0",
    type: "file",
    url: "https://huggingface.co/lmstudio-community/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q8_0.gguf",
    path: join(modelsDir, "Qwen3.5-0.8B-Q8_0.gguf"),
    minBytes: 500_000_000,
  },
];

const excludedAssets = [
  join(modelsDir, ".DS_Store"),
  join(modelsDir, "Soprano-1.1-80M"),
  join(modelsDir, "Qwen3-0.6B-Q8_0.gguf"),
  join(modelsDir, "Qwen3-1.7B-Q8_0.gguf"),
  join(modelsDir, "Qwen3-4B-Q4_K_M.gguf"),
  join(modelsDir, "Qwen3-8B-Q4_K_M.gguf"),
];

await mkdir(modelsDir, { recursive: true });

for (const target of excludedAssets) {
  if (existsSync(target)) {
    if (checkOnly) {
      throw new Error(`Excluded model asset is present: ${relative(target)}`);
    }
    await rm(target, { recursive: true, force: true });
    console.log(`Removed excluded model asset: ${relative(target)}`);
  }
}

if (pruneOnly) {
  console.log("Prune-only mode complete.");
  process.exit(0);
}

for (const asset of requiredAssets) {
  const present = await assetIsPresent(asset);
  if (present) {
    console.log(`Bundled model asset ready: ${asset.id}`);
    continue;
  }

  if (checkOnly) {
    throw new Error(`Missing required bundled model asset: ${asset.id}`);
  }

  if (asset.type === "file") {
    await downloadFile(asset.url, asset.path, asset.id);
  } else if (asset.type === "tarDirectory") {
    await downloadAndExtractDirectory(asset);
  } else {
    throw new Error(`Unknown bundled model asset type: ${asset.type}`);
  }

  if (!(await assetIsPresent(asset))) {
    throw new Error(`Bundled model asset did not verify after download: ${asset.id}`);
  }
}

console.log("Bundled model assets are ready for release packaging.");

async function assetIsPresent(asset) {
  try {
    const info = await stat(asset.path);
    if (asset.type === "file") {
      return info.isFile() && info.size >= asset.minBytes;
    }
    if (!info.isDirectory()) return false;
    for (const file of asset.expectedFiles ?? []) {
      const candidate = join(asset.path, file);
      if (!existsSync(candidate)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function downloadFile(url, destination, label) {
  await mkdir(dirname(destination), { recursive: true });
  const tempPath = `${destination}.partial`;
  await rm(tempPath, { force: true });

  console.log(`Downloading ${label} -> ${relative(destination)}`);
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${label}: HTTP ${response.status}`);
  }

  const total = Number(response.headers.get("content-length") ?? "0");
  let downloaded = 0;
  let lastLoggedAt = 0;
  const stream = Readable.fromWeb(response.body);
  stream.on("data", (chunk) => {
    downloaded += chunk.length;
    const now = Date.now();
    if (now - lastLoggedAt < 5_000) return;
    lastLoggedAt = now;
    if (total > 0) {
      const pct = Math.round((downloaded / total) * 100);
      console.log(`  ${label}: ${pct}%`);
    } else {
      console.log(`  ${label}: ${formatBytes(downloaded)}`);
    }
  });

  await pipeline(stream, createWriteStream(tempPath));
  await rm(destination, { recursive: true, force: true });
  await rename(tempPath, destination);
}

async function downloadAndExtractDirectory(asset) {
  await mkdir(workDir, { recursive: true });
  const archivePath = join(workDir, `${asset.id}.tar.gz`);
  const extractDir = join(workDir, `${asset.id}-extract`);
  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });

  await downloadFile(asset.url, archivePath, asset.id);

  console.log(`Extracting ${asset.id}`);
  const result = spawnSync("tar", ["-xzf", tarArg(archivePath), "-C", tarArg(extractDir)], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`Failed to extract ${asset.id}`);
  }

  const extracted = await findDirectory(extractDir, asset.directoryName);
  if (!extracted) {
    throw new Error(`Could not find ${asset.directoryName} inside ${asset.id}`);
  }

  await rm(asset.path, { recursive: true, force: true });
  await mkdir(dirname(asset.path), { recursive: true });
  await cp(extracted, asset.path, { recursive: true });
  await rm(extractDir, { recursive: true, force: true });
  await rm(archivePath, { force: true });
}

async function findDirectory(root, directoryName) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (!entry.isDirectory()) continue;
    if (entry.name === directoryName) return fullPath;
    const nested = await findDirectory(fullPath, directoryName);
    if (nested) return nested;
  }
  return null;
}

function relative(path) {
  return pathRelative(repoRoot, path).replaceAll("\\", "/");
}

function tarArg(path) {
  const relativePath = relative(path);
  return relativePath === "" ? "." : relativePath;
}

function formatBytes(bytes) {
  const mib = bytes / 1024 / 1024;
  return `${mib.toFixed(1)} MiB`;
}
