import * as core from "@actions/core";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import os from "node:os";
import crypto from "node:crypto";
import * as tar from "tar";
import semver from "semver";
import YAML from "yaml";

type FileCopyItem = { from: string; to: string; type?: "file" };
type DirCopyItem = { from: string; to: string; type: "dir"; clean?: boolean };
type CopyItem = FileCopyItem | DirCopyItem;

type LocalConfig = { items: CopyItem[] };

type Library = {
  npm: string;
  version: string;
  local?: LocalConfig;
};

type LibrariesConfig = {
  schemaVersion: number;
  baseDir: string;
  libraries: Library[];
};

function getWorkspaceRoot(): string {
  return process.env["GITHUB_WORKSPACE"] || process.cwd();
}

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await fs.stat(absolutePath);
    return true;
  } catch {
    return false;
  }
}

function toBoolean(input: string): boolean {
  return input.trim().toLowerCase() === "true";
}

function slugifyBranch(value: string): string {
  return value
    .replaceAll("@", "")
    .replaceAll("/", "-")
    .replaceAll(" ", "-")
    .replaceAll(":", "-")
    .replaceAll("+", "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

async function readLibrariesConfig(librariesPath: string): Promise<LibrariesConfig> {
  const raw = await fs.readFile(librariesPath, "utf8");
  const parsed = YAML.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid config: expected an object");
  }

  const config = parsed as Partial<LibrariesConfig>;
  if (config.schemaVersion !== 1) {
    throw new Error("Invalid config: unsupported schemaVersion");
  }
  if (typeof config.baseDir !== "string" || config.baseDir.length === 0) {
    throw new Error("Invalid config: baseDir must be a non-empty string");
  }
  if (!Array.isArray(config.libraries)) {
    throw new Error("Invalid config: libraries must be an array");
  }
  for (const lib of config.libraries) {
    if (!lib || typeof lib !== "object") throw new Error("Invalid config: invalid library entry");
    const maybe = lib as Partial<Library>;
    if (!maybe.npm || !maybe.version) throw new Error("Invalid config: each entry needs npm and version");
    if (maybe.local) {
      if (!Array.isArray(maybe.local.items)) {
        throw new Error(`Invalid config: local config invalid for ${maybe.npm}`);
      }
      if ("baseDir" in (maybe.local as any)) {
        throw new Error(`Invalid config: local.baseDir is not supported (library: ${maybe.npm})`);
      }
      for (const item of maybe.local.items) {
        if (!item || typeof item !== "object") throw new Error(`Invalid config: local item invalid for ${maybe.npm}`);
        const i = item as Partial<CopyItem>;
        if (typeof i.type !== "undefined" && i.type !== "file" && i.type !== "dir") {
          throw new Error(`Invalid config: local item type invalid for ${maybe.npm}`);
        }
        const from = (i as any).from;
        const to = (i as any).to;
        if (typeof from !== "string" || from.length === 0 || typeof to !== "string" || to.length === 0) {
          throw new Error(`Invalid config: local item needs non-empty from/to for ${maybe.npm}`);
        }
        if (i.type !== "dir" && typeof (i as any).clean !== "undefined") {
          throw new Error(`Invalid config: local item 'clean' is only valid for dir type (${maybe.npm})`);
        }
      }
    }
  }
  return config as LibrariesConfig;
}

function stripYamlQuotes(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === "'" && last === "'") || (first === `"` && last === `"`)) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

async function bumpLibraryVersionInFile(librariesPath: string, pkg: string, toVersion: string): Promise<void> {
  const raw = await fs.readFile(librariesPath, "utf8");
  const hasTrailingNewline = raw.endsWith("\n");
  const lines = raw.split(/\r?\n/);

  let inTarget = false;
  let updated = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const npmMatch = /^\s*-\s+npm:\s*(.+?)\s*$/.exec(line);
    if (npmMatch) {
      const name = stripYamlQuotes(npmMatch[1]);
      inTarget = name === pkg;
      continue;
    }
    if (!inTarget) continue;

    const versionMatch = /^(\s*version:\s*).*$/.exec(line);
    if (versionMatch) {
      lines[i] = `${versionMatch[1]}${toVersion}`;
      updated = true;
      break;
    }
  }

  if (!updated) throw new Error(`Failed to bump version in libraries.yml for ${pkg}`);

  const next = lines.join("\n") + (hasTrailingNewline ? "\n" : "");
  if (next !== raw) await fs.writeFile(librariesPath, next, "utf8");
}

function encodePackageForRegistry(pkg: string): string {
  return pkg.startsWith("@") ? pkg.replace("/", "%2f") : pkg;
}

type NpmVersionMeta = { dist: { tarball: string } };
type NpmPackument = { "dist-tags": Record<string, string>; versions: Record<string, NpmVersionMeta> };

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { "User-Agent": "librarybot" } });
  if (!res.ok) throw new Error(`Request failed: ${res.status} ${res.statusText} (${url})`);
  return (await res.json()) as T;
}

async function getLatestVersion(registryBase: string, pkg: string): Promise<{ latest: string; tarballUrl: string }> {
  const packumentUrl = `${registryBase.replace(/\/+$/, "")}/${encodePackageForRegistry(pkg)}`;
  const packument = await fetchJson<NpmPackument>(packumentUrl);
  const latest = packument["dist-tags"]?.latest;
  if (!latest) throw new Error(`npm registry did not return dist-tags.latest for ${pkg}`);
  const meta = packument.versions?.[latest];
  const tarballUrl = meta?.dist?.tarball;
  if (!tarballUrl) throw new Error(`npm registry did not return tarball url for ${pkg}@${latest}`);
  return { latest, tarballUrl };
}

async function downloadFile(url: string, absoluteFilePath: string): Promise<void> {
  const res = await fetch(url, { headers: { "User-Agent": "librarybot" } });
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText} (${url})`);
  const arrayBuffer = await res.arrayBuffer();
  await fs.mkdir(path.dirname(absoluteFilePath), { recursive: true });
  await fs.writeFile(absoluteFilePath, Buffer.from(arrayBuffer));
}

async function copyFile(absoluteFrom: string, absoluteTo: string): Promise<void> {
  await fs.mkdir(path.dirname(absoluteTo), { recursive: true });
  await fs.copyFile(absoluteFrom, absoluteTo);
}

async function copyDir(absoluteFromDir: string, absoluteToDir: string): Promise<void> {
  await fs.mkdir(absoluteToDir, { recursive: true });
  const entries = await fs.readdir(absoluteFromDir, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(absoluteFromDir, entry.name);
    const to = path.join(absoluteToDir, entry.name);
    if (entry.isDirectory()) {
      await copyDir(from, to);
    } else if (entry.isFile()) {
      await copyFile(from, to);
    }
  }
}

async function stripSourceMappingUrlIfNeeded(absoluteFilePath: string): Promise<void> {
  const ext = path.extname(absoluteFilePath).toLowerCase();
  if (ext !== ".js" && ext !== ".css") return;
  if (!(await pathExists(absoluteFilePath))) return;
  const raw = await fs.readFile(absoluteFilePath, "utf8");
  const stripped = raw
    .replace(/\n\/\/# sourceMappingURL=.*\n?$/g, "\n")
    .replace(/\n\/\*# sourceMappingURL=.*\*\/\n?$/g, "\n");
  if (stripped !== raw) await fs.writeFile(absoluteFilePath, stripped, "utf8");
}

async function updateCdnFiles(
  workspaceRoot: string,
  cdnFilePaths: string[],
  pkg: string,
  fromVersion: string,
  toVersion: string,
): Promise<void> {
  const fromToken = `${pkg}@${fromVersion}`;
  const toToken = `${pkg}@${toVersion}`;
  for (const rel of cdnFilePaths) {
    const absolute = path.resolve(workspaceRoot, rel);
    if (!(await pathExists(absolute))) continue;
    const raw = await fs.readFile(absolute, "utf8");
    const next = raw.split(fromToken).join(toToken);
    if (next !== raw) await fs.writeFile(absolute, next, "utf8");
  }
}

async function updateLibraryLocal(
  workspaceRoot: string,
  globalBaseDir: string,
  lib: Library,
  extractedPackageRoot: string,
): Promise<void> {
  if (!lib.local) return;
  const baseDir = path.resolve(workspaceRoot, globalBaseDir);
  const packageRoot = path.join(extractedPackageRoot, "package");

  for (const item of lib.local.items) {
    const fromAbs = path.resolve(packageRoot, item.from);
    const toAbs = path.resolve(baseDir, item.to);
    if (!(await pathExists(fromAbs))) throw new Error(`Missing npm file/dir for ${lib.npm}: ${item.from}`);

    if (item.type !== "dir") {
      await copyFile(fromAbs, toAbs);
      await stripSourceMappingUrlIfNeeded(toAbs);
      continue;
    }

    if (item.clean) await fs.rm(toAbs, { recursive: true, force: true });
    await copyDir(fromAbs, toAbs);
  }
}

function getGitStatusPorcelain(workspaceRoot: string): string {
  return execFileSync("git", ["status", "--porcelain"], { cwd: workspaceRoot, encoding: "utf8" });
}

async function updateSingleLibrary(params: {
  workspaceRoot: string;
  librariesPath: string;
  cdnFilePaths: string[];
  updateCdn: boolean;
  updateLocal: boolean;
  npmRegistryBase: string;
  libraryName: string;
}): Promise<{
  changed: boolean;
  fromVersion: string;
  toVersion: string;
  pkg: string;
  prBranch: string;
}> {
  const config = await readLibrariesConfig(params.librariesPath);
  const lib = config.libraries.find((l) => l.npm === params.libraryName);
  if (!lib) throw new Error(`Library not found in libraries.yml: ${params.libraryName}`);

  const fromVersion = lib.version;
  if (!semver.valid(fromVersion)) {
    return {
      changed: false,
      fromVersion,
      toVersion: fromVersion,
      pkg: lib.npm,
      prBranch: "",
    };
  }

  const { latest, tarballUrl } = await getLatestVersion(params.npmRegistryBase, lib.npm);
  const toVersion = latest;
  if (!semver.valid(toVersion) || semver.eq(fromVersion, toVersion) || semver.gt(fromVersion, toVersion)) {
    return {
      changed: false,
      fromVersion,
      toVersion: fromVersion,
      pkg: lib.npm,
      prBranch: "",
    };
  }

  const tempBase = await fs.mkdtemp(path.join(os.tmpdir(), "librarybot-"));
  const archivePath = path.join(tempBase, `${crypto.randomUUID()}.tgz`);
  const extractDir = path.join(tempBase, "extract");
  await fs.mkdir(extractDir, { recursive: true });

  await downloadFile(tarballUrl, archivePath);
  await tar.x({ file: archivePath, cwd: extractDir, gzip: true });

  if (params.updateLocal) {
    await updateLibraryLocal(params.workspaceRoot, config.baseDir, lib, extractDir);
  }
  if (params.updateCdn) {
    await updateCdnFiles(params.workspaceRoot, params.cdnFilePaths, lib.npm, fromVersion, toVersion);
  }

  lib.version = toVersion;
  await bumpLibraryVersionInFile(params.librariesPath, lib.npm, toVersion);

  const changed = getGitStatusPorcelain(params.workspaceRoot).trim().length > 0;
  const prBranch = `librarybot/${slugifyBranch(`${lib.npm}-${toVersion}`)}`;

  return { changed, fromVersion, toVersion, pkg: lib.npm, prBranch };
}

async function run(): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  const mode = core.getInput("mode") || "update";
  const configPathInput = core.getInput("config_path") || core.getInput("libraries_path") || "./librarybot.yml";
  const librariesPath = path.resolve(workspaceRoot, configPathInput);
  const npmRegistryBase = core.getInput("npm_registry") || "https://registry.npmjs.org";

  const cdnFilesInput = core.getInput("cdn_files") || "";
  const cdnFilePaths = cdnFilesInput
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const updateCdn = toBoolean(core.getInput("update_cdn") || "true");
  const updateLocal = toBoolean(core.getInput("update_local") || "true");

  if (mode === "list") {
    const config = await readLibrariesConfig(librariesPath);
    const librariesJson = JSON.stringify(config.libraries.map((l) => l.npm));
    core.setOutput("libraries_json", librariesJson);
    return;
  }

  const libraryName = core.getInput("library");
  if (!libraryName) throw new Error("Input 'library' is required when mode=update");

  const result = await updateSingleLibrary({
    workspaceRoot,
    librariesPath,
    cdnFilePaths,
    updateCdn,
    updateLocal,
    npmRegistryBase,
    libraryName,
  });

  core.setOutput("changed", String(result.changed));
  core.setOutput("from_version", result.fromVersion);
  core.setOutput("to_version", result.toVersion);
  core.setOutput("package", result.pkg);
  core.setOutput("pr_branch", result.prBranch);
}

run().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
