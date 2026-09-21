import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  THIRD_PARTY_ROOT,
  assertTool,
  command,
  gitHead,
  jupedSimPackage,
  jupedSimPythonExecutable,
  jupedSimRequirementsPath,
  jupedSimRunnerPath,
  jupedSimWheelPath,
  readThirdPartyLock,
  repositoryPath,
} from "../common/thirdParty";
import { sha256File } from "../../protocol/hash";
export function bootstrapBaselines(): void {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Pinned native baselines require Windows x64 and CPython 3.12; see docs/reproduction.md");
  const pythonIdentity = command("python", ["-c", "import sys; print(str(sys.version_info.major) + chr(46) + str(sys.version_info.minor))"], { capture: true });
  if (pythonIdentity !== "3.12") throw new Error("Pinned JuPedSim wheel requires CPython 3.12");
  assertTool("git", ["--version"]);
  assertTool("python", ["--version"]);
  assertTool("cmake", ["--version"]);
  try { assertTool("g++", ["--version"]); } catch { assertTool("cl", []); }
  const lock = readThirdPartyLock();
  mkdirSync(resolve(THIRD_PARTY_ROOT, "src"), { recursive: true });
  mkdirSync(resolve(THIRD_PARTY_ROOT, "build"), { recursive: true });

  for (const entry of lock.dependencies) {
    const source = repositoryPath(entry.sourceDirectory);
    if (!existsSync(resolve(source, ".git"))) {
      command("git", ["clone", "--config", "core.autocrlf=false", "--no-checkout", entry.repository, source]);
      command("git", ["-c", `safe.directory=${source.replaceAll("\\", "/")}`, "-C", source, "checkout", "--detach", entry.commit]);
    }
    if (gitHead(source) !== entry.commit) {
      throw new Error(`${entry.id} HEAD does not match the lock; remove ${source} and rerun bootstrap`);
    }
    const license = resolve(source, entry.licenseFile);
    if (!existsSync(license)) throw new Error(`${entry.id} license file is missing: ${license}`);
  }

  bootstrapJuPedSim();
  writeFileSync(
    resolve(THIRD_PARTY_ROOT, "build", "source-manifest.json"),
    `${JSON.stringify({
      sourceManifestVersion: 1,
      dependencies: Object.fromEntries(lock.dependencies.map((entry) => [entry.id, {
        commit: entry.commit,
        licenseSha256: sha256File(resolve(repositoryPath(entry.sourceDirectory), entry.licenseFile)),
        patchSha256: entry.patch?.sha256 ?? null,
      }])),
    }, null, 2)}\n`,
    "utf8",
  );
  console.log("baselines:bootstrap pinned sources and dedicated Python environments are ready");
}

function ensurePythonEnvironment(environmentPath: string): string {
  const environment = repositoryPath(environmentPath);
  const python = process.platform === "win32"
    ? resolve(environment, "Scripts", "python.exe")
    : resolve(environment, "bin", "python");
  if (!existsSync(python)) {
    mkdirSync(dirname(environment), { recursive: true });
    command("python", ["-m", "venv", environment]);
  }
  return python;
}

function bootstrapJuPedSim(): void {
  const lock = readThirdPartyLock();
  const packageLock = jupedSimPackage(lock);
  const requirements = jupedSimRequirementsPath(lock);
  if (sha256File(requirements) !== packageLock.requirementsLockSha256) {
    throw new Error("JuPedSim requirements lock hash does not match third-party-lock.json");
  }
  const wheel = jupedSimWheelPath(lock);
  const wheelCache = dirname(wheel);
  mkdirSync(wheelCache, { recursive: true });
  if (!existsSync(wheel)) {
    command("python", [
      "-m",
      "pip",
      "download",
      "--disable-pip-version-check",
      "--only-binary=:all:",
      "--no-deps",
      "--dest",
      wheelCache,
      "jupedsim==" + packageLock.version,
    ]);
  }
  if (sha256File(wheel) !== packageLock.wheelSha256) {
    throw new Error("Downloaded JuPedSim wheel hash does not match third-party-lock.json");
  }
  const python = ensurePythonEnvironment(packageLock.environment);
  command(python, [
    "-m",
    "pip",
    "install",
    "--disable-pip-version-check",
    "--require-hashes",
    "--only-binary=:all:",
    "-r",
    requirements,
  ]);
  const runner = jupedSimRunnerPath(lock);
  command(python, [runner, "--version"], { capture: true });
  const packageInfo = JSON.parse(command(python, [runner, "--package-info"], { capture: true })) as {
    jupedsimVersion?: string;
  };
  if (packageInfo.jupedsimVersion !== packageLock.version) {
    throw new Error("Installed JuPedSim package version is not exactly 1.4.2");
  }
  if (python !== jupedSimPythonExecutable(lock)) {
    throw new Error("JuPedSim environment path differs from the package lock");
  }
}

bootstrapBaselines();
