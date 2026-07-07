// Presupuesto de contexto: clasifica archivos y acota el tamano del diff que se
// envia al modelo. Objetivo doble: no reventar la ventana de tokens y no gastar
// presupuesto en ruido (lockfiles, binarios, build output). Funciones puras.

import type { ChangedFile } from "../github/client.ts";

export const FILE_CATEGORIES = [
  "source",
  "config",
  "dependency-manifest",
  "lockfile",
  "binary",
  "generated"
] as const;
export type FileCategory = (typeof FILE_CATEGORIES)[number];

const LOCKFILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "npm-shrinkwrap.json",
  "poetry.lock",
  "Cargo.lock",
  "composer.lock",
  "Gemfile.lock"
]);

const DEPENDENCY_MANIFESTS = new Set([
  "package.json",
  "requirements.txt",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "composer.json",
  "Gemfile",
  "pom.xml",
  "build.gradle"
]);

const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "pdf", "zip", "gz", "tar", "woff",
  "woff2", "ttf", "eot", "mp4", "mov", "wasm", "bin", "lock", "pptx", "docx", "xlsx"
]);

const GENERATED_PREFIXES = ["dist/", "build/", "coverage/", "node_modules/", "vendor/", ".next/", "out/"];
const GENERATED_SUFFIXES = [".min.js", ".min.css", ".map", ".snap"];

function baseName(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}

function extension(path: string): string {
  const name = baseName(path);
  const idx = name.lastIndexOf(".");
  return idx > 0 ? name.slice(idx + 1).toLowerCase() : "";
}

export function classifyPath(path: string): FileCategory {
  const name = baseName(path);
  if (LOCKFILES.has(name)) {
    return "lockfile";
  }
  if (DEPENDENCY_MANIFESTS.has(name)) {
    return "dependency-manifest";
  }
  if (GENERATED_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return "generated";
  }
  if (GENERATED_SUFFIXES.some((suffix) => path.endsWith(suffix))) {
    return "generated";
  }
  if (BINARY_EXTENSIONS.has(extension(path))) {
    return "binary";
  }
  const ext = extension(path);
  if (["json", "yaml", "yml", "toml", "ini", "env", "conf", "cfg", "xml"].includes(ext)) {
    return "config";
  }
  return "source";
}

export function truncate(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (text.length <= maxBytes) {
    return { text, truncated: false };
  }
  return { text: `${text.slice(0, maxBytes)}\n... [patch truncado por presupuesto] ...`, truncated: true };
}

export type SkippedFile = { path: string; reason: string };

export type BoundedDiff = {
  text: string;
  includedFiles: string[];
  skipped: SkippedFile[];
  truncated: boolean;
};

// Arma un diff acotado a partir de los archivos cambiados. Binarios y artefactos
// generados se listan pero su patch se omite; lockfiles se truncan agresivo; el
// total respeta maxDiffBytes.
export function buildBoundedDiff(
  files: ChangedFile[],
  opts: { maxDiffBytes: number; maxFilePatchBytes: number }
): BoundedDiff {
  const parts: string[] = [];
  const includedFiles: string[] = [];
  const skipped: SkippedFile[] = [];
  let totalBytes = 0;
  let truncated = false;

  for (const file of files) {
    const category = classifyPath(file.filename);
    const header = `### ${file.filename} [${file.status}, +${file.additions}/-${file.deletions}, ${category}]`;

    if (category === "binary" || category === "generated") {
      skipped.push({ path: file.filename, reason: category });
      continue;
    }
    if (!file.patch) {
      skipped.push({ path: file.filename, reason: "sin-patch" });
      continue;
    }
    if (totalBytes >= opts.maxDiffBytes) {
      skipped.push({ path: file.filename, reason: "presupuesto-diff-agotado" });
      truncated = true;
      continue;
    }

    const perFileCap = category === "lockfile" ? Math.min(2000, opts.maxFilePatchBytes) : opts.maxFilePatchBytes;
    const remaining = opts.maxDiffBytes - totalBytes;
    const capped = truncate(file.patch, Math.min(perFileCap, remaining));
    if (capped.truncated) {
      truncated = true;
    }
    const segment = `${header}\n${capped.text}`;
    parts.push(segment);
    totalBytes += segment.length;
    includedFiles.push(file.filename);
  }

  return { text: parts.join("\n\n"), includedFiles, skipped, truncated };
}
