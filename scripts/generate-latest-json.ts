import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, basename } from "node:path";
import { execSync } from "node:child_process";

const args = process.argv.slice(2);

const getArgValue = (name: string) => {
  const index = args.findIndex((arg) => arg === name);
  if (index === -1) return undefined;
  return args[index + 1];
};

const outputPath = getArgValue("--output") ?? getArgValue("-o");
const repoOverride = getArgValue("--repo");
const notesOverride = getArgValue("--notes");

const root = process.cwd();
const tauriConfigPath = resolve(root, "src-tauri", "tauri.conf.json");
const bundleRoot = resolve(root, "src-tauri", "target", "release", "bundle");

const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, "utf8")) as {
  version?: string;
};

const version = tauriConfig.version;
if (!version) {
  throw new Error("tauri.conf.json missing version field");
}

const repo =
  repoOverride ??
  process.env.GITHUB_REPO ??
  process.env.GITHUB_REPOSITORY ??
  inferRepoFromGit();

if (!repo) {
  throw new Error(
    "GitHub repo not provided. Pass --repo owner/name or set GITHUB_REPO.",
  );
}

const signatureFiles = findSignatureFiles(bundleRoot);
if (signatureFiles.length === 0) {
  throw new Error(
    `No update signatures found under ${bundleRoot}. Run a release build first.`,
  );
}

const platforms: Record<string, { url: string; signature: string }> = {};
for (const sigFile of signatureFiles) {
  const assetPath = sigFile.slice(0, -4);
  if (!existsSync(assetPath)) continue;

  const platform = platformForAsset(assetPath);
  if (!platform) continue;

  if (platforms[platform]) {
    console.warn(
      `Skipping ${basename(assetPath)} because ${platform} is already set.`,
    );
    continue;
  }

  const signature = readFileSync(sigFile, "utf8").trim();
  const assetName = basename(assetPath);
  const url = `https://github.com/${repo}/releases/download/v${version}/${assetName}`;

  platforms[platform] = { url, signature };
}

if (Object.keys(platforms).length === 0) {
  throw new Error("No updater artifacts found. Expected signed update assets.");
}

const payload = {
  version,
  notes: notesOverride ?? process.env.UPDATE_NOTES ?? "",
  pub_date: new Date().toISOString(),
  platforms,
};

const destination = outputPath
  ? resolve(root, outputPath)
  : resolve(bundleRoot, "latest.json");

writeFileSync(destination, JSON.stringify(payload, null, 2) + "\n");
console.log(`Wrote ${destination}`);

function inferRepoFromGit(): string | undefined {
  try {
    const remote = execSync("git remote get-url origin", {
      encoding: "utf8",
    }).trim();
    const match = remote.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function findSignatureFiles(rootDir: string): string[] {
  try {
    const output = execSync(`find "${rootDir}" -type f -name "*.sig"`, {
      encoding: "utf8",
    });
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function platformForAsset(assetPath: string): string | null {
  const name = basename(assetPath).toLowerCase();
  let os: "darwin" | "linux" | "windows" | null = null;

  if (name.endsWith(".app.tar.gz")) {
    os = "darwin";
  } else if (name.endsWith(".appimage.tar.gz")) {
    os = "linux";
  } else if (name.endsWith(".msi.zip") || name.endsWith(".exe.zip")) {
    os = "windows";
  } else {
    return null;
  }

  const archFromName = inferArchFromName(name);
  const arch = archFromName ?? defaultArch();
  return `${os}-${arch}`;
}

function inferArchFromName(name: string): "aarch64" | "x86_64" | null {
  if (name.includes("aarch64") || name.includes("arm64")) return "aarch64";
  if (name.includes("x86_64") || name.includes("x64") || name.includes("amd64")) {
    return "x86_64";
  }
  return null;
}

function defaultArch(): "aarch64" | "x86_64" {
  if (process.arch === "arm64") return "aarch64";
  return "x86_64";
}
