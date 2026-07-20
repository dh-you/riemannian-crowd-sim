import { mkdirSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { resolve } from "node:path";
import { sha256File } from "../../protocol/hash";
import {
  BUILD_MANIFEST_PATH,
  REPOSITORY_ROOT,
  THIRD_PARTY_ROOT,
  adapterSourceSha256,
  assertTool,
  command,
  dependency,
  gitHead,
  lockSha256,
  orcaRunnerPath,
  pythonExecutable,
  readThirdPartyLock,
  repositoryPath,
  socialForceRadiusRunnerPath,
  type BaselineBuildManifest,
} from "../common/thirdParty";

export function buildBaselines(): BaselineBuildManifest {
  const lock = readThirdPartyLock();
  const rvo2 = dependency(lock, "rvo2");
  const pysocialforce = dependency(lock, "pysocialforce");
  const rvoSource = repositoryPath(rvo2.sourceDirectory);
  const pySource = repositoryPath(pysocialforce.sourceDirectory);
  if (gitHead(rvoSource) !== rvo2.commit || gitHead(pySource) !== pysocialforce.commit) {
    throw new Error("Baseline source HEAD differs from the lock; rerun bootstrap");
  }
  const compiler = firstLine(assertTool("g++", ["--version"]));
  const cmake = firstLine(assertTool("cmake", ["--version"]));
  const buildDirectory = resolve(THIRD_PARTY_ROOT, "build", "rvo2");
  mkdirSync(buildDirectory, { recursive: true });
  command("cmake", [
    "-G", "Ninja",
    "-S", resolve(REPOSITORY_ROOT, "experiments", "baselines", "orca"),
    "-B", buildDirectory,
    `-DRVO2_SOURCE_DIR=${rvoSource.replaceAll("\\", "/")}`,
    "-DCMAKE_BUILD_TYPE=Release",
    "-DENABLE_OPENMP=OFF",
  ]);
  command("cmake", ["--build", buildDirectory, "--config", "Release", "--target", "orca_runner", "--parallel", "1"]);

  const python = pythonExecutable(lock);
  const pythonVersion = command(python, ["--version"], { capture: true });
  command(python, ["-c", "import numpy, toml, numba; print('PySocialForce runtime dependencies OK')"]);
  const packages = command(python, ["-m", "pip", "freeze", "--all"], { capture: true })
    .split(/\r?\n/u)
    .filter(Boolean)
    .sort();
  const orcaRunner = orcaRunnerPath(lock);
  const socialRunner = repositoryPath(lock.runners.socialForce);
  const radiusSocialRunner = socialForceRadiusRunnerPath();
  const manifest: BaselineBuildManifest = {
    buildManifestVersion: 1,
    lockSha256: lockSha256(),
    adapterSourceSha256: adapterSourceSha256(),
    upstreamCommits: { rvo2: rvo2.commit, pysocialforce: pysocialforce.commit },
    compiler,
    cmake,
    buildType: "Release",
    openMpEnabled: false,
    pythonExecutable: python,
    pythonVersion,
    pythonPackages: packages,
    platform: platform(),
    architecture: arch(),
    runners: {
      orca: orcaRunner,
      socialForce: socialRunner,
      radiusSocialForce: radiusSocialRunner,
    },
    runnerSha256: {
      orca: sha256File(orcaRunner),
      socialForce: sha256File(socialRunner),
      radiusSocialForce: sha256File(radiusSocialRunner),
    },
    timestamp: new Date().toISOString(),
  };
  mkdirSync(resolve(THIRD_PARTY_ROOT, "build"), { recursive: true });
  writeFileSync(BUILD_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`baselines:build ORCA=${orcaRunner}`);
  console.log(`baselines:build Python=${python}`);
  return manifest;
}

function firstLine(value: string): string {
  return value.split(/\r?\n/u)[0] ?? value;
}

buildBaselines();
