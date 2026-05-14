#!/usr/bin/env node
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, relative as pathRelative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resourcesDir = join(repoRoot, "src-tauri", "resources");
const bundledScriptsDir = join(resourcesDir, "scripts");
const bundledSenkoDir = join(resourcesDir, "senko");
const bundledPythonDir = join(bundledSenkoDir, "python");
const sourceScript = join(repoRoot, "scripts", "meetings_diarize.py");
const bundledScript = join(bundledScriptsDir, "meetings_diarize.py");
const localVenvDir = join(repoRoot, ".venv-senko");
const installScript = join(repoRoot, "scripts", "install-senko.sh");
const pythonVersion = "3.10.14";
const pythonMinor = "3.10";

const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");
const scriptOnly = args.has("--script-only");

await ensureBundledScript();

if (scriptOnly) {
  console.log(`Bundled Senko script ready: ${relative(bundledScript)}`);
  process.exit(0);
}

if (process.platform !== "darwin") {
  console.log("Bundled Senko runtime packaging is currently macOS-only; script copy complete.");
  process.exit(0);
}

if (checkOnly) {
  const pythonBin = await findBundledPythonBin();
  if (!pythonBin) {
    throw new Error("Missing bundled Senko Python runtime. Run `bun run senko:bundle`.");
  }
  await validateBundledSenko(pythonBin);
  console.log("Bundled Senko runtime verified.");
  process.exit(0);
}

await ensureManagedPython();
const pythonBin = await findBundledPythonBin();
if (!pythonBin) {
  throw new Error(`Could not find bundled Python ${pythonMinor} after uv install.`);
}
await ensureLocalSenkoVenv(pythonBin);
const sourceSitePackages = await resolveLocalSitePackages();

const pythonRoot = resolve(pythonBin, "..", "..");
const targetSitePackages = join(pythonRoot, "lib", `python${pythonMinor}`, "site-packages");

console.log(`Copying Senko packages into ${relative(targetSitePackages)}`);
await rm(targetSitePackages, { recursive: true, force: true });
await mkdir(dirname(targetSitePackages), { recursive: true });
await cp(sourceSitePackages, targetSitePackages, { recursive: true });

await validateBundledSenko(pythonBin);
console.log("Bundled Senko runtime is ready for release packaging.");

async function ensureBundledScript() {
  if (!existsSync(sourceScript)) {
    throw new Error(`Missing Senko diarization script: ${relative(sourceScript)}`);
  }
  if (checkOnly) {
    if (!existsSync(bundledScript)) {
      throw new Error(`Missing bundled Senko diarization script: ${relative(bundledScript)}`);
    }
    return;
  }
  await mkdir(bundledScriptsDir, { recursive: true });
  await cp(sourceScript, bundledScript);
}

async function ensureLocalSenkoVenv(pythonBin) {
  if (existsSync(await expectedLocalSitePackagesPath()) && localVenvUsesPython(pythonBin)) {
    return;
  }
  if (existsSync(localVenvDir)) {
    console.log("Recreating local Senko virtualenv with the managed release Python.");
    await rm(localVenvDir, { recursive: true, force: true });
  }
  if (!existsSync(installScript)) {
    throw new Error(`Missing Senko installer script: ${relative(installScript)}`);
  }
  console.log("Preparing local Senko virtualenv used as the package source.");
  try {
    await chmod(installScript, 0o755);
  } catch {
    // The spawn below will report the actionable error if chmod mattered.
  }
  run(installScript, [], {
    ...process.env,
    PYTHON_BIN: pythonBin,
    VENV_DIR: localVenvDir,
  });
}

function localVenvUsesPython(pythonBin) {
  const venvPython = join(localVenvDir, "bin", "python");
  if (!existsSync(venvPython)) return false;
  const result = spawnSync(
    venvPython,
    [
      "-c",
      "import pathlib, sys; print(pathlib.Path(getattr(sys, '_base_executable', sys.executable)).resolve())",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  if (result.status !== 0 || result.error) return false;
  return resolve(result.stdout.trim()) === resolve(pythonBin);
}

async function resolveLocalSitePackages() {
  const sitePackages = await expectedLocalSitePackagesPath();
  if (!existsSync(sitePackages)) {
    throw new Error(`Missing local Senko site-packages: ${relative(sitePackages)}`);
  }
  return sitePackages;
}

async function expectedLocalSitePackagesPath() {
  return join(localVenvDir, "lib", `python${pythonMinor}`, "site-packages");
}

async function ensureManagedPython() {
  const existing = await findBundledPythonBin();
  if (existing) return;
  if (!commandExists("uv")) {
    throw new Error("Missing uv. Install uv before preparing the bundled Senko runtime.");
  }
  await mkdir(bundledPythonDir, { recursive: true });
  run("uv", [
    "python",
    "install",
    pythonVersion,
    "--install-dir",
    bundledPythonDir,
    "--managed-python",
  ]);
}

async function findBundledPythonBin() {
  if (!existsSync(bundledPythonDir)) return null;
  const entries = await readdir(bundledPythonDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(`cpython-${pythonVersion}-`)) {
      continue;
    }
    for (const name of [`python${pythonMinor}`, "python3", "python"]) {
      const candidate = join(bundledPythonDir, entry.name, "bin", name);
      try {
        const info = await stat(candidate);
        if (info.isFile()) return candidate;
      } catch {
        // Try the next candidate.
      }
    }
  }
  return null;
}

async function validateBundledSenko(pythonBin) {
  const probe = [
    "import senko, senko.config as c",
    "from pathlib import Path",
    "required = []",
    "if hasattr(c, 'PYANNOTE_SEGMENTATION_COREML_MODEL_PATH'):",
    "    required.extend([c.PYANNOTE_SEGMENTATION_COREML_MODEL_PATH, c.EMBEDDINGS_COREML_PATH, c.FBANK_LIB_PATH, c.VAD_COREML_LIB_PATH])",
    "else:",
    "    fields = list(c.EMBEDDINGS_MODEL_FIELDS) + list(c.RUNTIME_PYANNOTE_COREML_MODEL_FIELDS)",
    "    paths = c.resolve_model_paths(None, required_fields=fields)",
    "    required.extend(getattr(paths, field) for field in fields)",
    "    required.extend([c.get_fbank_lib_path(), c.get_vad_coreml_lib_path()])",
    "missing = [str(path) for path in required if not Path(path).exists()]",
    "raise SystemExit('missing bundled Senko assets: ' + ', '.join(missing) if missing else 0)",
  ].join("\n");
  run(pythonBin, ["-c", probe], {
    ...process.env,
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONNOUSERSITE: "1",
  });
}

function commandExists(command) {
  const result = spawnSync("command", ["-v", command], {
    shell: true,
    stdio: "ignore",
  });
  return result.status === 0;
}

function run(command, commandArgs, env = process.env) {
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Command failed: ${[command, ...commandArgs].join(" ")}`);
  }
}

function relative(path) {
  return pathRelative(repoRoot, path).replaceAll("\\", "/");
}
