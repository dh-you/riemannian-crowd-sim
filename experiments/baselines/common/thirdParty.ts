import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Bytes, sha256File } from "../../protocol/hash";

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const THIRD_PARTY_ROOT = resolve(REPOSITORY_ROOT, "experiments", "third_party");
export const LOCK_PATH = resolve(REPOSITORY_ROOT, "experiments", "baselines", "third-party-lock.json");
export const BUILD_MANIFEST_PATH = resolve(THIRD_PARTY_ROOT, "build", "build-manifest.json");

export interface LockedPatch {
  path: string;
  sha256: string;
  reason: string;
}

export interface LockedDependency {
  id: "rvo2" | "pysocialforce";
  project: string;
  repository: string;
  commit: string;
  license: string;
  licenseFile: string;
  sourceType: "git";
  sourceDirectory: string;
  buildLocation: string;
  citation: string;
  patch: LockedPatch | null;
}

export interface ThirdPartyLock {
  lockVersion: 2;
  adapterVersion: "2";
  dependencies: LockedDependency[];
  pythonPackages: {
    jupedsim: LockedJuPedSimPackage;
  };
  runners: {
    orca: string;
    socialForce: string;
    pythonEnvironment: string;
    jupedsim: string;
  };
}

export interface LockedJuPedSimPackage {
  project: "JuPedSim";
  version: "1.4.2";
  repository: string;
  packageIndex: string;
  license: "LGPL-3.0-or-later";
  licenseFile: string;
  licenseSha256: string;
  wheelFilename: string;
  wheelSha256: string;
  requirementsLock: string;
  requirementsLockSha256: string;
  environment: string;
  installationCommand: string;
}

export interface BaselineBuildManifest {
  buildManifestVersion: 2;
  lockSha256: string;
  adapterSourceSha256: string;
  upstreamCommits: Record<string, string>;
  compiler: string;
  cmake: string;
  buildType: "Release";
  openMpEnabled: false;
  pythonExecutable: string;
  pythonVersion: string;
  pythonPackages: string[];
  jupedsimPythonExecutable: string;
  jupedsimPythonVersion: string;
  jupedsimPythonPackages: string[];
  jupedsimVersion: "1.4.2";
  jupedsimWheelFilename: string;
  jupedsimWheelSha256: string;
  jupedsimRequirementsLockSha256: string;
  jupedsimInstallationCommand: string;
  platform: string;
  architecture: string;
  runners: { orca: string; socialForce: string; jupedsim: string };
  runnerSha256: { orca: string; socialForce: string; jupedsim: string };
  timestamp: string;
}

export function readThirdPartyLock(): ThirdPartyLock {
  const value = JSON.parse(readFileSync(LOCK_PATH, "utf8")) as Partial<ThirdPartyLock>;
  if (value.lockVersion !== 2 || value.adapterVersion !== "2" || !Array.isArray(value.dependencies)) {
    throw new Error("Unsupported or malformed third-party lock file");
  }
  if (value.dependencies.length !== 2 || value.runners === undefined || value.pythonPackages === undefined) {
    throw new Error("Third-party lock must contain both baseline dependencies and runners");
  }
  for (const dependency of value.dependencies) {
    if (!/^[a-f0-9]{40}$/u.test(dependency.commit)) {
      throw new Error(`Invalid locked commit for ${dependency.id}`);
    }
    if (dependency.sourceType !== "git" || !dependency.repository.startsWith("https://github.com/")) {
      throw new Error(`Invalid source declaration for ${dependency.id}`);
    }
    if (dependency.patch !== null && !/^[a-f0-9]{64}$/u.test(dependency.patch.sha256)) {
      throw new Error(`Invalid patch hash for ${dependency.id}`);
    }
  }
  const jupedsim = value.pythonPackages.jupedsim;
  if (
    jupedsim.project !== "JuPedSim"
    || jupedsim.version !== "1.4.2"
    || jupedsim.license !== "LGPL-3.0-or-later"
    || jupedsim.wheelFilename !== "jupedsim-1.4.2-cp312-cp312-win_amd64.whl"
    || !/^[a-f0-9]{64}$/u.test(jupedsim.wheelSha256)
    || !/^[a-f0-9]{64}$/u.test(jupedsim.requirementsLockSha256)
    || !/^[a-f0-9]{64}$/u.test(jupedsim.licenseSha256)
  ) {
    throw new Error("Invalid locked JuPedSim 1.4.2 package declaration");
  }
  return value as ThirdPartyLock;
}

export function dependency(lock: ThirdPartyLock, id: LockedDependency["id"]): LockedDependency {
  const found = lock.dependencies.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`Missing locked dependency: ${id}`);
  return found;
}

export function repositoryPath(relativePath: string): string {
  const path = resolve(REPOSITORY_ROOT, relativePath);
  if (!path.startsWith(`${REPOSITORY_ROOT}\\`) && !path.startsWith(`${REPOSITORY_ROOT}/`)) {
    throw new Error(`Locked path escapes the repository: ${relativePath}`);
  }
  return path;
}

export function pythonExecutable(lock = readThirdPartyLock()): string {
  const environment = repositoryPath(lock.runners.pythonEnvironment);
  return process.platform === "win32"
    ? resolve(environment, "Scripts", "python.exe")
    : resolve(environment, "bin", "python");
}

export function jupedSimPackage(lock = readThirdPartyLock()): LockedJuPedSimPackage {
  return lock.pythonPackages.jupedsim;
}

export function jupedSimPythonExecutable(lock = readThirdPartyLock()): string {
  const environment = repositoryPath(jupedSimPackage(lock).environment);
  return process.platform === "win32"
    ? resolve(environment, "Scripts", "python.exe")
    : resolve(environment, "bin", "python");
}

export function jupedSimRunnerPath(lock = readThirdPartyLock()): string {
  return repositoryPath(lock.runners.jupedsim);
}

export function jupedSimRequirementsPath(lock = readThirdPartyLock()): string {
  return repositoryPath(jupedSimPackage(lock).requirementsLock);
}

export function jupedSimWheelPath(lock = readThirdPartyLock()): string {
  return resolve(THIRD_PARTY_ROOT, "build", "wheel-cache", jupedSimPackage(lock).wheelFilename);
}

export function orcaRunnerPath(lock = readThirdPartyLock()): string {
  const base = repositoryPath(lock.runners.orca);
  return process.platform === "win32" ? `${base}.exe` : base;
}

export function gitHead(source: string): string {
  return execFileSync("git", ["-c", `safe.directory=${source.replaceAll("\\", "/")}`, "-C", source, "rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function command(
  executable: string,
  arguments_: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; capture?: boolean; allowFailure?: boolean } = {},
): string {
  const result = spawnSync(executable, arguments_, {
    cwd: options.cwd ?? REPOSITORY_ROOT,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${executable} exited ${String(result.status)}${detail ? `: ${detail}` : ""}`);
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

export function assertTool(executable: string, arguments_: readonly string[]): string {
  try {
    return command(executable, arguments_, { capture: true });
  } catch (error) {
    throw new Error(`Required tool is unavailable: ${executable} (${error instanceof Error ? error.message : String(error)})`);
  }
}

export function adapterSourceSha256(): string {
  const roots = [
    resolve(REPOSITORY_ROOT, "experiments", "baselines", "common"),
    resolve(REPOSITORY_ROOT, "experiments", "baselines", "orca"),
    resolve(REPOSITORY_ROOT, "experiments", "baselines", "social_force"),
    resolve(REPOSITORY_ROOT, "experiments", "baselines", "jupedsim"),
    resolve(REPOSITORY_ROOT, "experiments", "baselines", "patches"),
    resolve(REPOSITORY_ROOT, "experiments", "engines"),
  ];
  const files = roots.flatMap(listFiles).sort();
  const identity = files.map((path) => {
    const relative = path.slice(REPOSITORY_ROOT.length + 1).replaceAll("\\", "/");
    return `${relative}\0${sha256File(path)}\n`;
  }).join("");
  return sha256Bytes(identity);
}

function listFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = resolve(path, entry.name);
    return entry.isDirectory() ? listFiles(child) : [child];
  }).filter((file) => ![".pyc", ".exe"].includes(extname(file)));
}

export function lockSha256(): string {
  return sha256File(LOCK_PATH);
}

export function readBuildManifest(): BaselineBuildManifest {
  if (!existsSync(BUILD_MANIFEST_PATH)) {
    throw new Error("Baseline build manifest is missing; run npm run baselines:build");
  }
  const manifest = JSON.parse(readFileSync(BUILD_MANIFEST_PATH, "utf8")) as BaselineBuildManifest;
  if (manifest.buildManifestVersion !== 2) throw new Error("Unsupported baseline build manifest");
  return manifest;
}
