import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { sha256File } from "../../protocol/hash";
import {
  REPOSITORY_ROOT,
  adapterSourceSha256,
  command,
  dependency,
  gitHead,
  lockSha256,
  orcaRunnerPath,
  pythonExecutable,
  readBuildManifest,
  readThirdPartyLock,
  repositoryPath,
  socialForceRadiusRunnerPath,
} from "../common/thirdParty";

export function verifyBaselines(): void {
  const lock = readThirdPartyLock();
  const build = readBuildManifest();
  if (build.lockSha256 !== lockSha256()) throw new Error("Baseline build is stale: lock hash changed");
  if (build.adapterSourceSha256 !== adapterSourceSha256()) {
    throw new Error("Baseline build is stale: adapter source hash changed");
  }
  for (const entry of lock.dependencies) {
    const source = repositoryPath(entry.sourceDirectory);
    if (gitHead(source) !== entry.commit) throw new Error(`${entry.id} source SHA does not match lock`);
    const gitArguments = ["-c", `safe.directory=${source.replaceAll("\\", "/")}`, "-C", source];
    const untracked = command("git", [...gitArguments, "ls-files", "--others", "--exclude-standard"], { capture: true });
    if (untracked !== "") throw new Error(`${entry.id} source tree contains untracked files: ${untracked}`);
    const upstreamLicense = resolve(source, entry.licenseFile);
    if (!existsSync(upstreamLicense)) throw new Error(`${entry.id} license file is missing`);
    const committedLicense = resolve(
      REPOSITORY_ROOT,
      "experiments",
      "baselines",
      "licenses",
      entry.id === "rvo2" ? "RVO2-APACHE-2.0.txt" : "PySocialForce-MIT.txt",
    );
    if (!existsSync(committedLicense)) throw new Error(`${entry.id} committed attribution license is missing`);
    if (sha256File(upstreamLicense) !== sha256File(committedLicense)) {
      throw new Error(`${entry.id} committed license does not match the pinned upstream file`);
    }
    if (entry.patch !== null) {
      const patch = repositoryPath(entry.patch.path);
      if (sha256File(patch) !== entry.patch.sha256) throw new Error(`${entry.id} patch hash differs from lock`);
      const expectedChangedPaths = [...readFileSync(patch, "utf8").matchAll(/^\+\+\+ b\/(.+)$/gmu)]
        .map((match) => match[1])
        .sort();
      const actualChangedPaths = command("git", [...gitArguments, "diff", "--name-only", "HEAD"], { capture: true })
        .split(/\r?\n/u)
        .filter(Boolean)
        .sort();
      if (JSON.stringify(actualChangedPaths) !== JSON.stringify(expectedChangedPaths)) {
        throw new Error(`${entry.id} source changes differ from the locked patch`);
      }
      const status = commandStatus("git", [
        ...gitArguments, "apply", "--reverse", "--check", patch,
      ]);
      if (status !== 0) throw new Error(`${entry.id} locked patch is not applied`);
    } else {
      const changed = command("git", [...gitArguments, "diff", "--name-only", "HEAD"], { capture: true });
      if (changed !== "") throw new Error(`${entry.id} source tree differs from its pinned commit: ${changed}`);
    }
  }
  const orca = orcaRunnerPath(lock);
  const social = repositoryPath(lock.runners.socialForce);
  const radiusSocial = socialForceRadiusRunnerPath();
  if (
    sha256File(orca) !== build.runnerSha256.orca
    || sha256File(social) !== build.runnerSha256.socialForce
    || sha256File(radiusSocial) !== build.runnerSha256.radiusSocialForce
  ) {
    throw new Error("Baseline runner hash differs from build manifest");
  }
  command(orca, ["--version"], { capture: true });
  const python = pythonExecutable(lock);
  command(python, [social, "--version"], { capture: true });
  command(python, [radiusSocial, "--version"], { capture: true });
  command(python, ["-c", "import numpy, toml, numba; print('imports OK')"], { capture: true });
  const currentPythonVersion = command(python, ["--version"], { capture: true });
  if (currentPythonVersion !== build.pythonVersion) throw new Error("Python version differs from build manifest");
  const currentPackages = command(python, ["-m", "pip", "freeze", "--all"], { capture: true })
    .split(/\r?\n/u)
    .filter(Boolean)
    .sort();
  if (JSON.stringify(currentPackages) !== JSON.stringify(build.pythonPackages)) {
    throw new Error("Python environment packages differ from build manifest");
  }
  if (build.upstreamCommits.rvo2 !== dependency(lock, "rvo2").commit ||
      build.upstreamCommits.pysocialforce !== dependency(lock, "pysocialforce").commit) {
    throw new Error("Build manifest upstream commits differ from lock");
  }
  console.log("baselines:verify PASS pinned sources, licenses, runners, environment, and build identity");
}

function commandStatus(executable: string, arguments_: readonly string[]): number | null {
  return spawnSync(executable, arguments_, { stdio: "ignore" }).status;
}

verifyBaselines();
