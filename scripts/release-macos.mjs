#!/usr/bin/env node
import {
  copyFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicRepo = getArgValue("--repo") ?? "KeystoneScience/breeze-releases";
const publish = hasFlag("--publish");
const commitAndPush = hasFlag("--commit-and-push");
const checkOnly = hasFlag("--check");
const dmgOnly = hasFlag("--dmg-only");
const manualOnly = hasFlag("--manual-only");
const plainDmg = hasFlag("--plain-dmg") || process.env.BREEZE_PLAIN_DMG === "1";
const notaryTimeout = getArgValue("--notary-timeout") ?? "45m";
const bumpMode = hasFlag("--no-bump")
  ? "none"
  : (getArgValue("--bump") ?? "auto");
const releaseDir = resolve(
  repoRoot,
  getArgValue("--release-dir") ?? `tmp/macos-release-${timestamp()}`,
);
const appPath = resolve(
  repoRoot,
  "src-tauri/target/release/bundle/macos/BreezeType.app",
);
const resourcesPath = join(appPath, "Contents/Resources/resources");
const entitlementsPath = resolve(repoRoot, "src-tauri/Entitlements.plist");
const dmgBackgroundPath = resolve(
  repoRoot,
  "src-tauri/dmg/BreezeTypeDmgBackground.png",
);
const dmgFileIconPngPath = resolve(
  repoRoot,
  "src-tauri/dmg/BreezeTypeDmgFileIcon.png",
);
const dmgFileIconIcnsPath = resolve(
  repoRoot,
  "src-tauri/dmg/BreezeTypeDmgFileIcon.icns",
);
const dmgVolumeName = "BreezeType";
const dmgAppName = "BreezeType.app";
const dmgBackgroundName = "BreezeTypeDmgBackground.png";
const dmgWindowOrigin = { x: 160, y: 120 };
const dmgWindowSize = { width: 760, height: 460 };
const dmgIconSize = 104;
const dmgAppPosition = { x: 190, y: 260 };
const dmgApplicationsPosition = { x: 570, y: 260 };
const updaterPrivateKeyPath = resolve(
  repoRoot,
  getArgValue("--updater-key") ?? "../.secrets/tauri/breeze-updater.key",
);
const notes =
  getArgValue("--notes") ?? process.env.UPDATE_NOTES ?? "Mac release.";

if (hasFlag("--help") || hasFlag("-h")) {
  console.log(`BreezeType macOS release builder

Usage:
  bun run release:mac -- [options]

Options:
  --check                Run preflight/version checks without building or publishing
  --publish              Upload BreezeType.dmg and updater assets to GitHub
  --manual-only          Build/publish only BreezeType.dmg; carry forward existing latest.json
  --commit-and-push      After a successful publish, commit tracked source changes and push
  --dmg-only             Build/notarize a DMG from the existing release app
  --bump auto            Default: bump patch only if the current version already has a release
  --bump patch|minor|major|none
  --no-bump              Alias for --bump none
  --repo owner/name      Public releases repo (default: KeystoneScience/breeze-releases)
  --release-dir path     Output directory (default: tmp/macos-release-<timestamp>)
  --identity name        Developer ID Application identity override
  --updater-key path     Tauri updater private key path
  --notes text           Release notes when creating/editing the GitHub release
  --notary-timeout 45m   Max wait for each Apple notarization submission
  --plain-dmg            Emergency fallback: skip Finder polish and create a basic DMG

Examples:
  bun run release:mac -- --check
  bun run release:mac -- --publish
  bun run release:mac -- --bump none --publish --commit-and-push
`);
  process.exit(0);
}

if (process.platform !== "darwin") {
  throw new Error("macOS releases must be built on macOS.");
}
if (dmgOnly && (publish || commitAndPush)) {
  throw new Error("--dmg-only cannot be combined with publishing options.");
}
if (manualOnly && commitAndPush) {
  throw new Error("--manual-only cannot be combined with --commit-and-push.");
}

loadDotEnv(resolve(repoRoot, ".env.local"));
normalizeUpdaterKeyPasswordEnv();
preflight();

if (checkOnly) {
  const version = readVersion();
  const tag = `v${version}`;
  const currentReleaseExists = releaseExists(tag);
  const identity = getArgValue("--identity") ?? findSigningIdentity();
  if (!identity) {
    throw new Error("No Developer ID Application signing identity found.");
  }
  console.log(`Preflight OK for BreezeType ${tag}.`);
  console.log(`Signing identity: ${identity}`);
  console.log(
    currentReleaseExists
      ? `Current tag ${tag} exists; --bump auto would bump patch.`
      : `Current tag ${tag} is not published; --bump auto would reuse it.`,
  );
  process.exit(0);
}

if (dmgOnly) {
  if (existsSync(releaseDir)) {
    throw new Error(`Release directory already exists: ${releaseDir}`);
  }
  await mkdir(releaseDir, { recursive: true });
  await mkdir(resolve(repoRoot, "tmp"), { recursive: true });
  writeFileSync(
    resolve(repoRoot, "tmp/latest-macos-release-dir.txt"),
    `${releaseDir}\n`,
  );

  const identity = getArgValue("--identity") ?? findSigningIdentity();
  if (!identity) {
    throw new Error("No Developer ID Application signing identity found.");
  }
  if (!existsSync(appPath)) {
    throw new Error(`Existing release app is missing: ${appPath}`);
  }

  console.log(`Building BreezeType DMG from ${appPath}`);
  console.log(`Release output: ${releaseDir}`);
  assertNoExternalMacLibraryReferences(appPath);
  assertMacDeploymentCompatibility(appPath);
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  run("xcrun", ["stapler", "validate", appPath]);
  run("spctl", ["-a", "-vvv", "-t", "execute", appPath]);

  const dmgPath = await createDmg(appPath, releaseDir, identity);
  notarize(dmgPath, "dmg");
  run("xcrun", ["stapler", "staple", dmgPath]);
  run("xcrun", ["stapler", "validate", dmgPath]);
  run("spctl", [
    "-a",
    "-t",
    "open",
    "--context",
    "context:primary-signature",
    "-v",
    dmgPath,
  ]);
  console.log(`Done. Artifacts are in ${releaseDir}`);
  process.exit(0);
}

if (existsSync(releaseDir)) {
  throw new Error(`Release directory already exists: ${releaseDir}`);
}
await mkdir(releaseDir, { recursive: true });
await mkdir(resolve(repoRoot, "tmp"), { recursive: true });
writeFileSync(
  resolve(repoRoot, "tmp/latest-macos-release-dir.txt"),
  `${releaseDir}\n`,
);

const startingVersion = readVersion();
const startingTag = `v${startingVersion}`;
let releaseAlreadyExists = releaseExists(startingTag);

if (bumpMode === "auto") {
  if (releaseAlreadyExists) {
    console.log(
      `Current tag ${startingTag} already exists; bumping patch version.`,
    );
    run("bun", ["scripts/bump-version.ts", "patch"]);
  } else {
    console.log(
      `Current tag ${startingTag} is not published; reusing current version.`,
    );
  }
} else if (bumpMode === "none") {
  console.log(`Version bump disabled; using ${startingVersion}.`);
} else if (["patch", "minor", "major"].includes(bumpMode)) {
  run("bun", ["scripts/bump-version.ts", bumpMode]);
} else {
  throw new Error(`Unsupported --bump value: ${bumpMode}`);
}

const version = readVersion();
const tag = `v${version}`;
releaseAlreadyExists = releaseExists(tag);
const identity = getArgValue("--identity") ?? findSigningIdentity();
if (!identity) {
  throw new Error("No Developer ID Application signing identity found.");
}

console.log(`Building BreezeType ${tag}`);
console.log(`Release output: ${releaseDir}`);
console.log(`Signing identity: ${identity}`);

await rm(appPath, { recursive: true, force: true });

run("bun", ["run", "release:prepare"]);

const buildEnv = {
  ...process.env,
  APPLE_TEAM_ID: requireEnv("APPLE_TEAM_ID"),
  APPLE_SIGNING_IDENTITY: identity,
  BREEZE_SKIP_SENKO_INSTALL: "1",
  LIBONNXRUNTIME_NO_PKG_CONFIG: "1",
};
delete buildEnv.APPLE_ID;
delete buildEnv.APPLE_PASSWORD;
delete buildEnv.APPLE_ID_PASSWORD;

run(
  "bun",
  [
    "run",
    "tauri",
    "build",
    "--bundles",
    "app",
    "--config",
    '{"bundle":{"createUpdaterArtifacts":false}}',
    "--ci",
  ],
  { env: buildEnv },
);

if (!existsSync(appPath)) {
  throw new Error(`Tauri build did not create ${appPath}`);
}

stripExternalMacRuntimePaths(appPath);
rewriteBundledMacLibraryIds(appPath);
assertNoExternalMacLibraryReferences(appPath);
assertMacDeploymentCompatibility(appPath);
signNestedMachO(resourcesPath, identity);
signAppWrapper(appPath, identity);
run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);

const appZipPath = join(releaseDir, "BreezeType.app.zip");
run("ditto", ["-c", "-k", "--keepParent", appPath, appZipPath]);
notarize(appZipPath, "app");
run("xcrun", ["stapler", "staple", appPath]);
run("xcrun", ["stapler", "validate", appPath]);
run("spctl", ["-a", "-vvv", "-t", "execute", appPath]);

if (manualOnly) {
  carryForwardLatestJson(releaseDir);
} else {
  run("bun", [
    "run",
    "release:package-updater",
    "--",
    "--app",
    appPath,
    "--out-dir",
    releaseDir,
    "--repo",
    publicRepo,
    "--private-key-path",
    updaterPrivateKeyPath,
    "--latest",
    join(releaseDir, "latest.json"),
  ]);
}

const dmgPath = await createDmg(appPath, releaseDir, identity);
notarize(dmgPath, "dmg");
run("xcrun", ["stapler", "staple", dmgPath]);
run("xcrun", ["stapler", "validate", dmgPath]);
run("spctl", [
  "-a",
  "-t",
  "open",
  "--context",
  "context:primary-signature",
  "-v",
  dmgPath,
]);

if (publish) {
  publishRelease(tag, releaseAlreadyExists, releaseDir, dmgPath);
  verifyPublished(tag, version);
} else {
  console.log(
    "Skipping GitHub upload. Re-run with --publish to upload the release assets.",
  );
}

if (commitAndPush) {
  if (!publish) {
    throw new Error(
      "--commit-and-push is only allowed after --publish succeeds.",
    );
  }
  commitAndPushSource(tag);
}

console.log(`Done. Artifacts are in ${releaseDir}`);

function preflight() {
  run("xcrun", ["-find", "notarytool"], { quiet: true });
  run("xcrun", ["-find", "stapler"], { quiet: true });
  run("bun", ["--version"], { quiet: true });
  run("rustc", ["--version"], { quiet: true });
  run("gh", ["auth", "status"], { quiet: true });
  run("gh", ["repo", "view", publicRepo, "--json", "nameWithOwner"], {
    quiet: true,
  });

  for (const name of ["APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"]) {
    requireEnv(name);
  }

  if (!dmgOnly && !manualOnly) {
    if (!existsSync(updaterPrivateKeyPath)) {
      throw new Error(
        `Missing Tauri updater private key: ${updaterPrivateKeyPath}`,
      );
    }
    if (updaterKeyLooksEncrypted() && !process.env.TAURI_PRIVATE_KEY_PASSWORD) {
      throw new Error(
        "Encrypted Tauri updater key requires TAURI_SIGNING_PRIVATE_KEY_PASSWORD. The legacy TAURI_PRIVATE_KEY_PASSWORD alias is also accepted.",
      );
    }
  }
  if (!existsSync(entitlementsPath)) {
    throw new Error(`Missing entitlements file: ${entitlementsPath}`);
  }
  if (!plainDmg && !existsSync(dmgBackgroundPath)) {
    throw new Error(`Missing DMG background image: ${dmgBackgroundPath}`);
  }
}

function readVersion() {
  const packageJson = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8"),
  );
  const tauriConfig = JSON.parse(
    readFileSync(join(repoRoot, "src-tauri/tauri.conf.json"), "utf8"),
  );
  const cargoToml = readFileSync(
    join(repoRoot, "src-tauri/Cargo.toml"),
    "utf8",
  );
  const packageVersion = String(packageJson.version ?? "");
  const tauriVersion = String(tauriConfig.version ?? "");
  const cargoVersion =
    cargoToml.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1] ?? "";
  if (!/^\d+\.\d+\.\d+$/.test(packageVersion)) {
    throw new Error(`Unsupported package.json version: ${packageVersion}`);
  }
  if (packageVersion !== tauriVersion) {
    throw new Error(
      `Version mismatch: package.json=${packageVersion}, tauri.conf.json=${tauriVersion}`,
    );
  }
  if (packageVersion !== cargoVersion) {
    throw new Error(
      `Version mismatch: package.json=${packageVersion}, Cargo.toml=${cargoVersion}`,
    );
  }
  return packageVersion;
}

function findSigningIdentity() {
  const output = capture("security", [
    "find-identity",
    "-v",
    "-p",
    "codesigning",
  ]);
  const line = output
    .split(/\r?\n/)
    .find((candidate) => candidate.includes("Developer ID Application"));
  return line?.match(/"([^"]+)"/)?.[1];
}

function signNestedMachO(root, identity) {
  if (!existsSync(root)) {
    throw new Error(`Bundled resources directory is missing: ${root}`);
  }
  const files = collectMachOCandidates(root).filter((filePath) =>
    capture("file", [filePath]).includes("Mach-O"),
  );
  console.log(`Signing ${files.length} nested Mach-O resource files.`);
  for (const filePath of files) {
    run("codesign", [
      "--force",
      "--options",
      "runtime",
      "--timestamp",
      "--sign",
      identity,
      filePath,
    ]);
  }
}

function collectMachOCandidates(root) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    const currentLstat = lstatSync(current);
    if (currentLstat.isSymbolicLink()) continue;
    if (currentLstat.isDirectory()) {
      for (const name of readdirSync(current)) {
        stack.push(join(current, name));
      }
      continue;
    }
    if (!currentLstat.isFile()) continue;

    const lower = current.toLowerCase();
    const executable = Boolean(statSync(current).mode & 0o111);
    if (
      executable ||
      lower.endsWith(".so") ||
      lower.endsWith(".dylib") ||
      lower.endsWith(".node")
    ) {
      out.push(current);
    }
  }
  return out;
}

function collectMachOFiles(root) {
  return collectMachOCandidates(root).filter((filePath) =>
    capture("file", [filePath]).includes("Mach-O"),
  );
}

function stripExternalMacRuntimePaths(targetAppPath) {
  const files = collectMachOFiles(targetAppPath);
  let stripped = 0;

  for (const filePath of files) {
    for (const rpath of readMachORpaths(filePath)) {
      if (!isForbiddenMacLocalReference(rpath)) continue;
      run("install_name_tool", ["-delete_rpath", rpath, filePath]);
      stripped += 1;
    }
  }

  if (stripped > 0) {
    console.log(`Removed ${stripped} local LC_RPATH entries from bundled Mach-O files.`);
  }
}

function rewriteBundledMacLibraryIds(targetAppPath) {
  const files = collectMachOFiles(targetAppPath);
  let rewritten = 0;

  for (const filePath of files) {
    const libraryId = readMachOLibraryId(filePath);
    if (!libraryId || !isForbiddenMacLocalReference(libraryId)) continue;
    const newId = `@rpath/${basename(libraryId)}`;
    run("install_name_tool", ["-id", newId, filePath]);
    rewritten += 1;
  }

  if (rewritten > 0) {
    console.log(`Rewrote ${rewritten} bundled Mach-O library install names.`);
  }
}

function assertNoExternalMacLibraryReferences(targetAppPath) {
  const findings = [];
  const files = collectMachOFiles(targetAppPath);

  for (const filePath of files) {
    const linkedLibraries = readMachOLinkedLibraries(filePath);
    for (const libraryPath of linkedLibraries) {
      if (isForbiddenMacLocalReference(libraryPath)) {
        findings.push(`${releaseRelative(filePath)} links ${libraryPath}`);
      }
    }
    for (const rpath of readMachORpaths(filePath)) {
      if (isForbiddenMacLocalReference(rpath)) {
        findings.push(`${releaseRelative(filePath)} has LC_RPATH ${rpath}`);
      }
    }
  }

  if (findings.length > 0) {
    throw new Error(
      [
        "Release app contains external local library references:",
        ...findings,
        "Use vendored/static dependencies or bundle and sign dylibs inside the app.",
      ].join("\n"),
    );
  }
}

function readMachOLinkedLibraries(filePath) {
  return capture("otool", ["-L", filePath])
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line && !line.endsWith(":"))
    .map((line) => line.split(/\s+\(/)[0])
    .filter(Boolean);
}

function assertMacDeploymentCompatibility(targetAppPath) {
  const minimumVersion = readBundleMinimumSystemVersion(targetAppPath);
  const findings = [];

  for (const filePath of collectMachOFiles(targetAppPath)) {
    const buildInfo = capture("vtool", ["-show-build", filePath], {
      maxBuffer: 20 * 1024 * 1024,
    });
    const minVersions = [...buildInfo.matchAll(/\bminos\s+([0-9]+(?:\.[0-9]+){0,2})/g)]
      .map((match) => match[1]);
    for (const minVersion of minVersions) {
      if (compareVersions(minVersion, minimumVersion) > 0) {
        findings.push(
          `${releaseRelative(filePath)} requires macOS ${minVersion}, above bundle minimum ${minimumVersion}`,
        );
      }
    }
  }

  if (findings.length > 0) {
    throw new Error(
      [
        "Release app contains Mach-O files newer than LSMinimumSystemVersion:",
        ...findings.slice(0, 80),
        findings.length > 80 ? `...and ${findings.length - 80} more` : null,
        "Raise bundle.macOS.minimumSystemVersion or rebuild/remove the newer native payload.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

function readBundleMinimumSystemVersion(targetAppPath) {
  const infoPlistPath = join(targetAppPath, "Contents", "Info.plist");
  const version = capture("plutil", [
    "-extract",
    "LSMinimumSystemVersion",
    "raw",
    infoPlistPath,
  ]).trim();
  if (!/^\d+(?:\.\d+){0,2}$/.test(version)) {
    throw new Error(`Invalid LSMinimumSystemVersion: ${version}`);
  }
  return version;
}

function readMachORpaths(filePath) {
  const rpaths = [];
  const output = capture("otool", ["-l", filePath], { maxBuffer: 20 * 1024 * 1024 });
  let inRpath = false;
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "cmd LC_RPATH") {
      inRpath = true;
      continue;
    }
    if (!inRpath) continue;
    const match = trimmed.match(/^path\s+(.+?)\s+\(offset\s+\d+\)$/);
    if (match) {
      rpaths.push(match[1]);
      inRpath = false;
    }
  }
  return rpaths;
}

function readMachOLibraryId(filePath) {
  const output = capture("otool", ["-D", filePath], { maxBuffer: 20 * 1024 * 1024 })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return output.length >= 2 ? output[1] : null;
}

function isForbiddenMacLocalReference(path) {
  if (
    path.startsWith("@") ||
    path.startsWith("/System/Library/") ||
    path.startsWith("/usr/lib/")
  ) {
    return false;
  }
  return [
    /^\/Users\/[^/]+\//,
    /^\/opt\/homebrew\//,
    /^\/opt\/local\//,
    /^\/usr\/local\/(?:Cellar|opt|lib)\//,
  ].some((pattern) => pattern.test(path));
}

function compareVersions(left, right) {
  const leftParts = left.split(".").map((part) => Number(part));
  const rightParts = right.split(".").map((part) => Number(part));
  const count = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < count; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart !== rightPart) return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

function releaseRelative(path) {
  return relative(repoRoot, path).replaceAll("\\", "/");
}

function signAppWrapper(targetAppPath, identity) {
  run("codesign", [
    "--force",
    "--options",
    "runtime",
    "--timestamp",
    "--entitlements",
    entitlementsPath,
    "--sign",
    identity,
    targetAppPath,
  ]);
}

async function createDmg(targetAppPath, outDir, identity) {
  if (plainDmg) {
    return createPlainDmg(targetAppPath, outDir, identity);
  }

  const rwDmgPath = join(outDir, "BreezeType-rw.dmg");
  const dmgPath = join(outDir, "BreezeType.dmg");
  await rm(rwDmgPath, { force: true });
  await rm(dmgPath, { force: true });

  const appSizeMb = Math.ceil(directorySizeBytes(targetAppPath) / 1024 / 1024);
  // HFS+ images need generous catalog/block headroom for large app bundles with
  // many small embedded runtime files; the final UDZO image is compressed later.
  const sizeMb = Math.ceil(appSizeMb * 1.25) + 768;
  run("hdiutil", [
    "create",
    "-volname",
    dmgVolumeName,
    "-size",
    `${sizeMb}m`,
    "-fs",
    "HFS+",
    "-type",
    "UDIF",
    "-ov",
    rwDmgPath,
  ]);

  const mountPoint = attachDmg(rwDmgPath);
  try {
    run("ditto", [targetAppPath, join(mountPoint, dmgAppName)]);
    run("ln", ["-s", "/Applications", join(mountPoint, "Applications")]);
    await mkdir(join(mountPoint, ".background"), { recursive: true });
    run("ditto", [
      dmgBackgroundPath,
      join(mountPoint, ".background", dmgBackgroundName),
    ]);
    run("chflags", ["hidden", join(mountPoint, ".background")]);
    installDmgVolumeIcon(mountPoint);
    configureDmgFinderWindow(mountPoint);
    run("sync", []);
  } finally {
    detachDmg(mountPoint);
  }

  run("hdiutil", [
    "convert",
    rwDmgPath,
    "-format",
    "UDZO",
    "-imagekey",
    "zlib-level=9",
    "-o",
    dmgPath,
  ]);
  await rm(rwDmgPath, { force: true });
  run("codesign", ["--force", "--timestamp", "--sign", identity, dmgPath]);
  applyDmgFileIcon(dmgPath);
  run("codesign", ["--verify", "--verbose=2", dmgPath]);
  verifyDmgLayout(dmgPath);
  return dmgPath;
}

async function createPlainDmg(targetAppPath, outDir, identity) {
  const staging = join(outDir, "dmg-staging");
  const dmgPath = join(outDir, "BreezeType.dmg");
  await rm(staging, { recursive: true, force: true });
  await rm(dmgPath, { force: true });
  await mkdir(staging, { recursive: true });
  run("ditto", [targetAppPath, join(staging, dmgAppName)]);
  run("ln", ["-s", "/Applications", join(staging, "Applications")]);
  installDmgVolumeIcon(staging);
  run("hdiutil", [
    "create",
    "-volname",
    dmgVolumeName,
    "-srcfolder",
    staging,
    "-format",
    "UDZO",
    "-ov",
    dmgPath,
  ]);
  run("codesign", ["--force", "--timestamp", "--sign", identity, dmgPath]);
  applyDmgFileIcon(dmgPath);
  run("codesign", ["--verify", "--verbose=2", dmgPath]);
  verifyDmgLayout(dmgPath, { requireBackground: false });
  return dmgPath;
}

function installDmgVolumeIcon(volumePath) {
  if (!existsSync(dmgFileIconIcnsPath)) return;
  const volumeIconPath = join(volumePath, ".VolumeIcon.icns");
  run("ditto", [dmgFileIconIcnsPath, volumeIconPath]);
  run("SetFile", ["-c", "icnC", volumeIconPath]);
  run("SetFile", ["-a", "V", volumeIconPath]);
  run("SetFile", ["-a", "C", volumePath]);
}

function applyDmgFileIcon(dmgPath) {
  if (!existsSync(dmgFileIconPngPath)) return;

  const iconSourcePath = join(
    dirname(dmgPath),
    "BreezeTypeDmgFileIcon-source.png",
  );
  const resourcePath = join(dirname(dmgPath), "BreezeTypeDmgFileIcon.rsrc");

  try {
    copyFileSync(dmgFileIconPngPath, iconSourcePath);
    run("sips", ["-i", iconSourcePath]);
    writeFileSync(
      resourcePath,
      capture("DeRez", ["-only", "icns", iconSourcePath], {
        maxBuffer: 20 * 1024 * 1024,
      }),
    );
    run("Rez", ["-append", resourcePath, "-o", dmgPath]);
    run("SetFile", ["-a", "C", dmgPath]);

    const finderAttributes = capture("GetFileInfo", ["-a", dmgPath]).trim();
    if (!finderAttributes.includes("C")) {
      throw new Error("DMG file custom icon flag was not set.");
    }
    const iconResources = capture("DeRez", ["-only", "icns", dmgPath], {
      maxBuffer: 20 * 1024 * 1024,
    });
    if (!/data 'icns' \(-16455\)/.test(iconResources)) {
      throw new Error("DMG file custom icon resource was not embedded.");
    }
  } finally {
    rmSync(iconSourcePath, { force: true });
    rmSync(resourcePath, { force: true });
  }
}

function configureDmgFinderWindow(mountPoint) {
  const backgroundPath = join(mountPoint, ".background", dmgBackgroundName);
  const right = dmgWindowOrigin.x + dmgWindowSize.width;
  const bottom = dmgWindowOrigin.y + dmgWindowSize.height;
  const script = `
on run argv
  set volumePath to item 1 of argv
  set backgroundPath to item 2 of argv
  tell application "Finder"
    set dmgFolder to POSIX file volumePath as alias
    open dmgFolder
    delay 0.5
    set dmgWindow to container window of dmgFolder
    set current view of dmgWindow to icon view
    try
      set toolbar visible of dmgWindow to false
    end try
    try
      set statusbar visible of dmgWindow to false
    end try
    set bounds of dmgWindow to {${dmgWindowOrigin.x}, ${dmgWindowOrigin.y}, ${right}, ${bottom}}
    set viewOptions to icon view options of dmgWindow
    set arrangement of viewOptions to not arranged
    set icon size of viewOptions to ${dmgIconSize}
    set background picture of viewOptions to (POSIX file backgroundPath as alias)
    set position of item "${dmgAppName}" of dmgFolder to {${dmgAppPosition.x}, ${dmgAppPosition.y}}
    set position of item "Applications" of dmgFolder to {${dmgApplicationsPosition.x}, ${dmgApplicationsPosition.y}}
    update dmgFolder without registering applications
    delay 1
    try
      close dmgWindow
    end try
  end tell
end run
`.trim();

  console.log("> osascript configure DMG Finder window");
  const result = spawnSync(
    "osascript",
    ["-e", script, mountPoint, backgroundPath],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error("Failed to configure DMG Finder window.");
  }
}

function verifyDmgLayout(dmgPath, options = {}) {
  const requireBackground = options.requireBackground ?? true;
  const mountPoint = attachDmg(dmgPath, { readonly: true });
  try {
    const appInDmg = join(mountPoint, dmgAppName);
    const applicationsLink = join(mountPoint, "Applications");
    if (!existsSync(appInDmg)) {
      throw new Error(`DMG is missing ${dmgAppName}.`);
    }
    if (!lstatSync(applicationsLink).isSymbolicLink()) {
      throw new Error("DMG Applications target is not a symlink.");
    }
    if (requireBackground) {
      const backgroundInDmg = join(
        mountPoint,
        ".background",
        dmgBackgroundName,
      );
      if (!existsSync(backgroundInDmg)) {
        throw new Error("DMG is missing its Finder background image.");
      }
      if (!existsSync(join(mountPoint, ".DS_Store"))) {
        throw new Error("DMG is missing Finder layout metadata.");
      }
    }
  } finally {
    detachDmg(mountPoint);
  }
}

function attachDmg(dmgPath, options = {}) {
  const commandArgs = ["attach", "-nobrowse", "-noverify", "-noautoopen"];
  if (options.readonly) commandArgs.push("-readonly");
  commandArgs.push(dmgPath);
  const output = capture("hdiutil", commandArgs);
  const mountLine = output
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.includes("/Volumes/"));
  const mountPoint = mountLine?.match(/(\/Volumes\/.+)$/)?.[1]?.trim();
  if (!mountPoint) {
    throw new Error(`Unable to find mounted volume for ${dmgPath}.`);
  }
  return mountPoint;
}

function detachDmg(mountPoint) {
  const result = spawnSync("hdiutil", ["detach", mountPoint], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status === 0) return;
  run("hdiutil", ["detach", "-force", mountPoint]);
}

function directorySizeBytes(root) {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    const currentLstat = lstatSync(current);
    if (currentLstat.isSymbolicLink()) {
      total += currentLstat.size;
      continue;
    }
    if (currentLstat.isDirectory()) {
      for (const name of readdirSync(current)) {
        stack.push(join(current, name));
      }
      continue;
    }
    if (currentLstat.isFile()) {
      total += currentLstat.size;
    }
  }
  return total;
}

function notarize(targetPath, label) {
  const attempts = [{ noS3Acceleration: false }];
  if (process.env.BREEZE_NOTARY_NO_S3_ACCELERATION === "1") {
    attempts[0].noS3Acceleration = true;
  } else {
    attempts.push({ noS3Acceleration: true });
  }

  for (const attempt of attempts) {
    const result = submitForNotarization(targetPath, attempt);
    if (result.status === 0) return;

    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const canRetry =
      !attempt.noS3Acceleration &&
      /abortedUpload|Operation timed out|Network\.NWError/i.test(output);
    if (canRetry) {
      console.log(
        "Notary upload timed out; retrying with S3 acceleration disabled.",
      );
      continue;
    }

    fetchNotarizationLog(output, label);
    throw new Error(`Notarization failed for ${targetPath}`);
  }
}

function submitForNotarization(targetPath, { noS3Acceleration }) {
  const argsForNotary = [
    "notarytool",
    "submit",
    targetPath,
    "--apple-id",
    requireEnv("APPLE_ID"),
    "--password",
    requireEnv("APPLE_PASSWORD"),
    "--team-id",
    requireEnv("APPLE_TEAM_ID"),
    "--wait",
    "--timeout",
    notaryTimeout,
  ];
  if (noS3Acceleration) argsForNotary.push("--no-s3-acceleration");

  console.log(
    `> xcrun notarytool submit ${basename(targetPath)} --wait${
      noS3Acceleration ? " --no-s3-acceleration" : ""
    }`,
  );
  const result = spawnSync("xcrun", argsForNotary, {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error) throw result.error;
  return result;
}

function fetchNotarizationLog(output, label) {
  const submissionId = output.match(/id:\s*([0-9a-f-]{36})/i)?.[1];
  if (submissionId) {
    const logPath = join(releaseDir, `notary-${label}-log.json`);
    console.log(`Fetching notarization log: ${logPath}`);
    runSensitive("xcrun", [
      "notarytool",
      "log",
      submissionId,
      logPath,
      "--apple-id",
      requireEnv("APPLE_ID"),
      "--password",
      requireEnv("APPLE_PASSWORD"),
      "--team-id",
      requireEnv("APPLE_TEAM_ID"),
    ]);
  }
}

function publishRelease(tag, releaseAlreadyExists, outDir, dmgPath) {
  const assets = manualOnly
    ? [dmgPath, join(outDir, "latest.json")]
    : [
        dmgPath,
        join(outDir, "BreezeType.app.tar.gz"),
        join(outDir, "BreezeType.app.tar.gz.sig"),
        join(outDir, "latest.json"),
      ];
  for (const asset of assets) {
    if (!existsSync(asset)) throw new Error(`Missing release asset: ${asset}`);
  }

  if (releaseAlreadyExists) {
    run("gh", [
      "release",
      "edit",
      tag,
      "-R",
      publicRepo,
      "--title",
      tag,
      "--notes",
      notes,
      "--latest",
    ]);
  } else {
    run("gh", [
      "release",
      "create",
      tag,
      "-R",
      publicRepo,
      "--title",
      tag,
      "--notes",
      notes,
      "--latest",
    ]);
  }

  run("gh", [
    "release",
    "upload",
    tag,
    "-R",
    publicRepo,
    "--clobber",
    ...assets,
  ]);
}

function verifyPublished(tag, version) {
  run("gh", ["release", "view", tag, "-R", publicRepo]);

  const latestUrl = `https://github.com/${publicRepo}/releases/latest/download/latest.json`;
  const latest = JSON.parse(capture("curl", ["-fsSL", latestUrl]));
  if (manualOnly) {
    console.log(
      `Manual-only release published; updater latest.json remains at ${latest.version}.`,
    );
  } else {
    if (latest.version !== version) {
      throw new Error(
        `latest.json version mismatch: expected ${version}, got ${latest.version}`,
      );
    }
    const darwinPlatform =
      latest.platforms?.["darwin-aarch64"] ??
      latest.platforms?.["darwin-x86_64"];
    if (!darwinPlatform?.url?.includes(`${tag}/BreezeType.app.tar.gz`)) {
      throw new Error(
        "latest.json does not point at this release's updater archive.",
      );
    }
    if (!darwinPlatform.signature) {
      throw new Error("latest.json is missing the updater signature.");
    }
  }

  const githubHeaders = capture("curl", [
    "-sI",
    "-L",
    `https://github.com/${publicRepo}/releases/latest/download/BreezeType.dmg`,
  ]);
  if (!/filename=BreezeType\.dmg/i.test(githubHeaders)) {
    throw new Error(
      "GitHub latest DMG download does not resolve to BreezeType.dmg.",
    );
  }

  const websiteHeaders = capture("curl", [
    "-sI",
    "-L",
    "https://breezetype.com/api/download/mac?download=release-check",
  ]);
  if (!websiteHeaders.includes(`${tag}/BreezeType.dmg`)) {
    throw new Error(
      "Website download route does not redirect to the new BreezeType.dmg.",
    );
  }
}

function carryForwardLatestJson(outDir) {
  const latestPath = join(outDir, "latest.json");
  if (existsSync(latestPath)) return;
  const latestUrl = `https://github.com/${publicRepo}/releases/latest/download/latest.json`;
  const latestJson = capture("curl", ["-fsSL", latestUrl]);
  JSON.parse(latestJson);
  writeFileSync(
    latestPath,
    latestJson.endsWith("\n") ? latestJson : `${latestJson}\n`,
  );
  console.log(
    "Carried forward existing latest.json because this is a manual-DMG-only release.",
  );
}

function commitAndPushSource(tag) {
  const branch = capture("git", ["branch", "--show-current"]).trim();
  if (!branch)
    throw new Error("Cannot push source changes from a detached HEAD.");
  run("git", ["add", "-u"]);
  const diff = spawnSync("git", ["diff", "--cached", "--quiet"], {
    cwd: repoRoot,
    env: process.env,
  });
  if (diff.status === 0) {
    console.log("No tracked source changes to commit.");
    return;
  }
  if (diff.error) throw diff.error;
  run("git", ["commit", "-m", `Release ${tag}`]);
  run("git", ["push", "origin", branch]);
}

function releaseExists(tag) {
  const result = spawnSync("gh", ["release", "view", tag, "-R", publicRepo], {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
  });
  if (result.status === 0) return true;
  if (/release not found/i.test(result.stderr ?? "")) return false;
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  throw new Error(`Unable to check GitHub release ${tag}.`);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function loadDotEnv(path) {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, raw] = match;
    if (process.env[key]) continue;
    process.env[key] = parseDotEnvValue(raw.trim());
  }
}

function parseDotEnvValue(raw) {
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }
  return raw.replace(/\s+#.*$/, "");
}

function normalizeUpdaterKeyPasswordEnv() {
  const password =
    process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??
    process.env.TAURI_PRIVATE_KEY_PASSWORD;
  if (!password) return;
  process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = password;
  process.env.TAURI_PRIVATE_KEY_PASSWORD = password;
}

function updaterKeyLooksEncrypted() {
  const raw = readFileSync(updaterPrivateKeyPath, "utf8").trim();
  const candidates = [raw];
  try {
    candidates.push(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    // Keep the raw-key heuristic when the key is not base64 encoded.
  }
  return candidates.some((candidate) =>
    /encrypted\s+secret\s+key|encrypted\s+private\s+key/i.test(
      candidate.slice(0, 256),
    ),
  );
}

function run(command, commandArgs, options = {}) {
  if (!options.quiet) console.log(`> ${[command, ...commandArgs].join(" ")}`);
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    env: options.env ?? process.env,
    stdio: options.quiet ? "ignore" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command}`);
  }
}

function runSensitive(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command}`);
  }
}

function capture(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    maxBuffer: options.maxBuffer,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`Command failed: ${command}`);
  }
  return result.stdout;
}

function getArgValue(name) {
  const index = args.findIndex((arg) => arg === name);
  return index === -1 ? undefined : args[index + 1];
}

function hasFlag(name) {
  return args.includes(name);
}

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
}
