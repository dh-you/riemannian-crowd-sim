import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import {
  REPOSITORY_ROOT,
  THIRD_PARTY_ROOT,
  assertTool,
  command,
  dependency,
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
import {
  restoreLockedManagedCheckout,
} from "./managedCheckout";

const PYTHON_TEST_DEPENDENCIES = [
  "pytest==8.4.1",
  "matplotlib==3.10.3",
] as const;

const PYTHON_TEST_PACKAGES = [
  "pytest",
  "matplotlib",
  "iniconfig",
  "pluggy",
  "pygments",
  "contourpy",
  "cycler",
  "fonttools",
  "kiwisolver",
  "pillow",
  "pyparsing",
  "python-dateutil",
  "six",
] as const;

const PYSOCIALFORCE_TEST_MARKER = resolve(
  THIRD_PARTY_ROOT,
  "build",
  "pysocialforce-unpatched-tests.json",
);

export function bootstrapBaselines(): void {
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
      command("git", ["clone", "--no-checkout", entry.repository, source]);
      command("git", ["-c", `safe.directory=${source.replaceAll("\\", "/")}`, "-C", source, "checkout", "--detach", entry.commit]);
    }
    if (gitHead(source) !== entry.commit) {
      throw new Error(`${entry.id} HEAD does not match the lock; remove ${source} and rerun bootstrap`);
    }
    const license = resolve(source, entry.licenseFile);
    if (!existsSync(license)) throw new Error(`${entry.id} license file is missing: ${license}`);
  }

  const python = ensurePythonEnvironment(lock.runners.pythonEnvironment);
  const requirements = resolve(REPOSITORY_ROOT, "experiments", "baselines", "social_force", "requirements.lock");
  command(python, ["-m", "pip", "install", "--disable-pip-version-check", "-r", requirements]);
  bootstrapJuPedSim();
  const pysocialforce = dependency(lock, "pysocialforce");
  const pySource = repositoryPath(pysocialforce.sourceDirectory);
  const patch = pysocialforce.patch;
  if (patch === null) throw new Error("PySocialForce goal-threshold patch is not locked");
  const patchPath = repositoryPath(patch.path);
  if (sha256File(patchPath) !== patch.sha256) throw new Error("PySocialForce patch hash does not match lock");
  const gitArguments = ["-c", `safe.directory=${pySource.replaceAll("\\", "/")}`, "-C", pySource];
  const patchAlreadyApplied = commandStatus("git", [...gitArguments, "apply", "--reverse", "--check", patchPath]) === 0;
  if (!patchAlreadyApplied || !lockedPatchTreeIsExact(pySource, patchPath) ||
      !unpatchedTestMarkerIsValid(pysocialforce.commit)) {
    verifyUnpatchedPySocialForce(python, pySource, pysocialforce.commit);
    command("git", [...gitArguments, "apply", "--check", patchPath]);
    command("git", [...gitArguments, "apply", patchPath]);
  }
  if (commandStatus("git", [...gitArguments, "apply", "--reverse", "--check", patchPath]) !== 0) {
    throw new Error("Locked PySocialForce patch is not applied exactly");
  }
  verifyLockedPatchPaths(pySource, patchPath);
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

function verifyUnpatchedPySocialForce(python: string, source: string, commit: string): void {
  const log = resolve(THIRD_PARTY_ROOT, "build", "pysocialforce-unpatched-tests.log");
  restoreLockedManagedCheckout({
    source,
    expectedSource: source,
    lockedCommit: commit,
  });
  const mustRunTests = !unpatchedTestMarkerIsValid(commit);
  if (!mustRunTests) return;

  const failures: unknown[] = [];
  let testsPassed = false;
  try {
    command(python, [
      "-m",
      "pip",
      "install",
      "--disable-pip-version-check",
      ...PYTHON_TEST_DEPENDENCIES,
    ]);
    const env = { ...process.env, PYTHONPATH: source, MPLBACKEND: "Agg" };
    runLoggedCommand(
      python,
      ["-m", "pytest", "-q", resolve(source, "tests")],
      log,
      { cwd: source, env },
    );
    testsPassed = true;
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      command(python, ["-m", "pip", "uninstall", "-y", ...PYTHON_TEST_PACKAGES]);
    } catch (error) {
      failures.push(new Error(`Failed to remove temporary PySocialForce test dependencies: ${errorMessage(error)}`));
    }
    try {
      restoreLockedManagedCheckout({
        source,
        expectedSource: source,
        lockedCommit: commit,
      });
    } catch (error) {
      failures.push(new Error(`Failed to restore the locked PySocialForce checkout: ${errorMessage(error)}`));
    }
  }

  if (failures.length > 0 || !testsPassed) {
    throw new AggregateError(failures, "Unpatched PySocialForce verification or cleanup failed");
  }
  writeFileSync(
    PYSOCIALFORCE_TEST_MARKER,
    `${JSON.stringify({ commit, passed: true }, null, 2)}\n`,
    "utf8",
  );
}

function unpatchedTestMarkerIsValid(commit: string): boolean {
  if (!existsSync(PYSOCIALFORCE_TEST_MARKER)) return false;
  try {
    const value = JSON.parse(readFileSync(PYSOCIALFORCE_TEST_MARKER, "utf8")) as {
      commit?: string;
      passed?: boolean;
    };
    return value.commit === commit && value.passed === true;
  } catch {
    return false;
  }
}

function runLoggedCommand(
  executable: string,
  arguments_: readonly string[],
  logPath: string,
  options: { cwd: string; env: NodeJS.ProcessEnv },
): void {
  const result = spawnSync(executable, arguments_, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [
    `$ ${executable} ${arguments_.join(" ")}`,
    result.stdout,
    result.stderr,
    result.error?.message,
  ].filter(Boolean).join("\n");
  writeFileSync(logPath, `${output.trimEnd()}\n`, "utf8");
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`PySocialForce upstream tests exited ${String(result.status)}; see ${logPath}`);
  }
}

function verifyLockedPatchPaths(source: string, patchPath: string): void {
  if (!lockedPatchTreeIsExact(source, patchPath)) {
    throw new Error("PySocialForce source differs from the locked patch or contains generated artifacts");
  }
}

function lockedPatchTreeIsExact(source: string, patchPath: string): boolean {
  const gitArguments = ["-c", `safe.directory=${source.replaceAll("\\", "/")}`, "-C", source];
  const expected = [...readFileSync(patchPath, "utf8").matchAll(/^\+\+\+ b\/(.+)$/gmu)]
    .map((match) => match[1])
    .sort();
  const actual = command("git", [...gitArguments, "diff", "--name-only", "HEAD"], { capture: true })
    .split(/\r?\n/u)
    .filter(Boolean)
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) return false;
  const untracked = command(
    "git",
    [...gitArguments, "ls-files", "--others", "--exclude-standard"],
    { capture: true },
  );
  const ignored = command(
    "git",
    [...gitArguments, "ls-files", "--others", "--ignored", "--exclude-standard"],
    { capture: true },
  );
  return untracked === "" && ignored === "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commandStatus(executable: string, arguments_: readonly string[]): number | null {
  return spawnSync(executable, arguments_, { stdio: "ignore" }).status;
}

bootstrapBaselines();
