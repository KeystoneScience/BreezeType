import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const bumpRaw = args.find((arg) => !arg.startsWith("-")) ?? "patch";
const bump = ["patch", "minor", "major"].includes(bumpRaw)
  ? (bumpRaw as "patch" | "minor" | "major")
  : null;
if (!bump) {
  throw new Error(`Unknown bump type: ${bumpRaw}`);
}
const shouldStage = args.includes("--stage");

const root = process.cwd();
const packageJsonPath = resolve(root, "package.json");
const tauriConfigPath = resolve(root, "src-tauri", "tauri.conf.json");
const cargoTomlPath = resolve(root, "src-tauri", "Cargo.toml");

const readJson = (path: string) =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

const packageJson = readJson(packageJsonPath);
const currentVersion = String(packageJson.version ?? "");
const match = currentVersion.match(/^(\d+)\.(\d+)\.(\d+)$/);
if (!match) {
  throw new Error(`Unsupported version format: ${currentVersion}`);
}

const [_, majorStr, minorStr, patchStr] = match;
let major = Number(majorStr);
let minor = Number(minorStr);
let patch = Number(patchStr);

switch (bump) {
  case "major":
    major += 1;
    minor = 0;
    patch = 0;
    break;
  case "minor":
    minor += 1;
    patch = 0;
    break;
  case "patch":
  default:
    patch += 1;
    break;
}

const nextVersion = `${major}.${minor}.${patch}`;
packageJson.version = nextVersion;
writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + "\n");

const tauriConfig = readJson(tauriConfigPath);
if (typeof tauriConfig.version !== "string") {
  throw new Error("tauri.conf.json missing version field");
}
updateTauriConfig(tauriConfig, nextVersion, tauriConfigPath);

const cargoToml = readFileSync(cargoTomlPath, "utf8").split("\n");
let inPackage = false;
let cargoUpdated = false;
const updatedCargo = cargoToml.map((line) => {
  const trimmed = line.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    inPackage = trimmed === "[package]";
  }
  if (inPackage && trimmed.startsWith("version") && trimmed.includes("=")) {
    cargoUpdated = true;
    return line.replace(/version\s*=\s*"[^"]+"/, `version = "${nextVersion}"`);
  }
  return line;
});
if (!cargoUpdated) {
  throw new Error("Failed to update Cargo.toml version under [package]");
}
writeFileSync(cargoTomlPath, updatedCargo.join("\n") + "\n");

console.log(`Version bumped: ${currentVersion} -> ${nextVersion}`);

if (shouldStage) {
  execSync(
    `git add "${packageJsonPath}" "${tauriConfigPath}" "${cargoTomlPath}"`,
    { stdio: "inherit" },
  );
}

function updateTauriConfig(
  tauriConfig: Record<string, unknown>,
  next: string,
  path: string,
) {
  tauriConfig.version = next;
  writeFileSync(path, JSON.stringify(tauriConfig, null, 2) + "\n");
}
