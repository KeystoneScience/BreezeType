#!/usr/bin/env node
import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import javascriptObfuscator from "javascript-obfuscator";

const distDir = resolve(process.cwd(), "dist");
const sourceMapReferencePattern = /(?:\r?\n)?\/\/# sourceMappingURL=.*$/gm;
const hasSourceMapReferencePattern = /\/\/# sourceMappingURL=/;

const obfuscationOptions = {
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  debugProtection: false,
  disableConsoleOutput: false,
  identifierNamesGenerator: "hexadecimal",
  renameGlobals: false,
  selfDefending: false,
  sourceMap: false,
  stringArray: true,
  stringArrayCallsTransform: false,
  stringArrayEncoding: [],
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayThreshold: 0.25,
  target: "browser",
  transformObjectKeys: false,
  unicodeEscapeSequence: false,
};

if (!existsSync(distDir)) {
  throw new Error(`Cannot obfuscate missing dist directory: ${distDir}`);
}

const jsFiles = [];
const mapFiles = [];

await collectBuildFiles(distDir);

if (jsFiles.length === 0) {
  throw new Error(`No JavaScript files found under ${distDir}`);
}

for (const file of mapFiles) {
  await unlink(file);
}

for (const file of jsFiles) {
  const source = await readFile(file, "utf8");
  const sourceWithoutMapReference = source.replace(
    sourceMapReferencePattern,
    "",
  );
  const obfuscated = javascriptObfuscator
    .obfuscate(sourceWithoutMapReference, obfuscationOptions)
    .getObfuscatedCode();

  if (hasSourceMapReferencePattern.test(obfuscated)) {
    throw new Error(
      `Obfuscated output still contains a sourcemap reference: ${file}`,
    );
  }

  await writeFile(file, obfuscated);
}

console.log(
  `Obfuscated ${jsFiles.length} JavaScript bundle(s); removed ${mapFiles.length} sourcemap file(s).`,
);

async function collectBuildFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(directory, entry.name);

    if (entry.isDirectory()) {
      await collectBuildFiles(fullPath);
      continue;
    }

    if (!entry.isFile()) continue;

    const extension = extname(entry.name);
    if (extension === ".js") {
      jsFiles.push(fullPath);
    } else if (extension === ".map") {
      mapFiles.push(fullPath);
    }
  }
}
