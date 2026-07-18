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
  pythonExecutable,
  readThirdPartyLock,
  repositoryPath,
} from "../common/thirdParty";
import { sha256File } from "../../protocol/hash";

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

  const python = ensurePythonEnvironment();
  const requirements = resolve(REPOSITORY_ROOT, "experiments", "baselines", "social_force", "requirements.lock");
  command(python, ["-m", "pip", "install", "--disable-pip-version-check", "-r", requirements]);
  const pysocialforce = dependency(lock, "pysocialforce");
  const pySource = repositoryPath(pysocialforce.sourceDirectory);
  const patch = pysocialforce.patch;
  if (patch === null) throw new Error("PySocialForce goal-threshold patch is not locked");
  const patchPath = repositoryPath(patch.path);
  if (sha256File(patchPath) !== patch.sha256) throw new Error("PySocialForce patch hash does not match lock");
  const gitArguments = ["-c", `safe.directory=${pySource.replaceAll("\\", "/")}`, "-C", pySource];
  const patchAlreadyApplied = commandStatus("git", [...gitArguments, "apply", "--reverse", "--check", patchPath]) === 0;
  if (!patchAlreadyApplied) {
    verifyUnpatchedPySocialForce(python, pySource, pysocialforce.commit);
    command("git", [...gitArguments, "apply", "--check", patchPath]);
    command("git", [...gitArguments, "apply", patchPath]);
  }
  if (commandStatus("git", [...gitArguments, "apply", "--reverse", "--check", patchPath]) !== 0) {
    throw new Error("Locked PySocialForce patch is not applied exactly");
  }
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
  console.log("baselines:bootstrap pinned sources and dedicated Python environment are ready");
}

function ensurePythonEnvironment(): string {
  const lock = readThirdPartyLock();
  const python = pythonExecutable(lock);
  if (!existsSync(python)) {
    const environment = repositoryPath(lock.runners.pythonEnvironment);
    mkdirSync(dirname(environment), { recursive: true });
    command("python", ["-m", "venv", environment]);
  }
  return python;
}

function verifyUnpatchedPySocialForce(python: string, source: string, commit: string): void {
  const marker = resolve(THIRD_PARTY_ROOT, "build", "pysocialforce-unpatched-tests.json");
  if (existsSync(marker)) {
    const value = JSON.parse(readFileSync(marker, "utf8")) as { commit?: string; passed?: boolean };
    if (value.commit === commit && value.passed === true) return;
  }
  command(python, ["-m", "pip", "install", "--disable-pip-version-check", "pytest==8.4.1", "matplotlib==3.10.3"]);
  const env = { ...process.env, PYTHONPATH: source, MPLBACKEND: "Agg" };
  command(python, ["-m", "pytest", "-q", resolve(source, "tests")], { cwd: source, env });
  command(python, ["-m", "pip", "uninstall", "-y", "pytest", "matplotlib", "iniconfig", "pluggy", "pygments", "contourpy", "cycler", "fonttools", "kiwisolver", "pillow", "pyparsing", "python-dateutil", "six"]);
  writeFileSync(marker, `${JSON.stringify({ commit, passed: true }, null, 2)}\n`, "utf8");
}

function commandStatus(executable: string, arguments_: readonly string[]): number | null {
  return spawnSync(executable, arguments_, { stdio: "ignore" }).status;
}

bootstrapBaselines();
