import { existsSync, readFileSync } from "node:fs";
import { sha256Bytes, sha256File } from "../protocol/hash";
import { createJuPedSimGeometry } from "../baselines/jupedsim/geometry";
import {
  BUILD_MANIFEST_PATH,
  REPOSITORY_ROOT,
  adapterSourceSha256,
  command,
  dependency,
  gitHead,
  jupedSimPackage,
  jupedSimPythonExecutable,
  jupedSimRequirementsPath,
  jupedSimRunnerPath,
  jupedSimWheelPath,
  lockSha256,
  orcaRunnerPath,
  pythonExecutable,
  readBuildManifest,
  readThirdPartyLock,
  repositoryPath,
} from "../baselines/common/thirdParty";
import {
  JUPEDSIM_SFM_ADAPTER_VERSION,
  ORCA_ADAPTER_VERSION,
  SOCIAL_FORCE_ADAPTER_VERSION,
  type EngineProvenance,
} from "./ExperimentEngine";
import { serializeCanonicalMethodConfig } from "../protocol/methodIdentity";
import type { JuPedSimSfmMethodConfig } from "../protocol/methodConfig";
import type { ExperimentScenario } from "../protocol/schema";

export function baselineProvenance(kind: "orca" | "pysocialforce"): EngineProvenance {
  const lock = readThirdPartyLock();
  const build = readBuildManifest();
  if (build.lockSha256 !== lockSha256() || build.adapterSourceSha256 !== adapterSourceSha256()) {
    throw new Error("Baseline build provenance is stale; run npm run baselines:build");
  }
  const entry = dependency(lock, kind === "orca" ? "rvo2" : "pysocialforce");
  assertPinnedSource(entry);
  if (build.upstreamCommits[entry.id] !== entry.commit) {
    throw new Error(`${entry.project} build provenance does not match the locked upstream commit`);
  }
  const runner = kind === "orca" ? orcaRunnerPath(lock) : repositoryPath(lock.runners.socialForce);
  const expectedRunnerHash = kind === "orca" ? build.runnerSha256.orca : build.runnerSha256.socialForce;
  if (!existsSync(runner) || sha256File(runner) !== expectedRunnerHash) {
    throw new Error(`Baseline runner is missing or stale: ${runner}`);
  }
  if (kind === "pysocialforce" && !existsSync(pythonExecutable(lock))) {
    throw new Error("PySocialForce environment is missing; run npm run baselines:bootstrap");
  }
  return {
    engineId: kind === "orca" ? "orca_rvo2_engine_v1" : "pysocialforce_engine_v1",
    engineAdapterVersion:
      kind === "orca" ? ORCA_ADAPTER_VERSION : SOCIAL_FORCE_ADAPTER_VERSION,
    correctionMode: "native_none",
    commandVelocityMeaning:
      kind === "orca"
        ? "RVO2-selected velocity used for the native integration step"
        : "native pre-position-update velocity after PySocialForce force integration",
    thirdPartyLockSha256: lockSha256(),
    upstreamProject: entry.project,
    upstreamRepository: entry.repository,
    upstreamCommit: entry.commit,
    upstreamLicense: entry.license,
    runnerPath: runner,
    runnerSha256: expectedRunnerHash,
    buildManifestSha256: sha256File(BUILD_MANIFEST_PATH),
    engineSpecificProvenance: {},
    limitations:
      kind === "pysocialforce"
        ? ["Pinned PySocialForce supports one scene-wide pedestrian radius; heterogeneous-radius scenarios are rejected."]
        : ["RVO2 uses single-precision arithmetic; cross-compiler last-bit variation may occur."],
  };
}

export function jupedSimProvenance(
  scenario: ExperimentScenario,
  method: JuPedSimSfmMethodConfig,
): EngineProvenance {
  const lock = readThirdPartyLock();
  const build = readBuildManifest();
  const packageLock = jupedSimPackage(lock);
  if (build.lockSha256 !== lockSha256() || build.adapterSourceSha256 !== adapterSourceSha256()) {
    throw new Error("Baseline build provenance is stale; run npm run baselines:build");
  }
  const runner = jupedSimRunnerPath(lock);
  const python = jupedSimPythonExecutable(lock);
  const requirements = jupedSimRequirementsPath(lock);
  const wheel = jupedSimWheelPath(lock);
  if (!existsSync(python)) {
    throw new Error("JuPedSim environment is missing; run npm run baselines:bootstrap");
  }
  if (!existsSync(runner) || sha256File(runner) !== build.runnerSha256.jupedsim) {
    throw new Error("JuPedSim runner is missing or stale");
  }
  if (!existsSync(requirements) || sha256File(requirements) !== packageLock.requirementsLockSha256) {
    throw new Error("JuPedSim requirements lock is missing or stale");
  }
  if (!existsSync(wheel) || sha256File(wheel) !== packageLock.wheelSha256) {
    throw new Error("JuPedSim wheel cache is missing or stale");
  }
  if (
    build.jupedsimVersion !== packageLock.version
    || build.jupedsimWheelFilename !== packageLock.wheelFilename
    || build.jupedsimWheelSha256 !== packageLock.wheelSha256
    || build.jupedsimRequirementsLockSha256 !== packageLock.requirementsLockSha256
    || build.jupedsimInstallationCommand !== packageLock.installationCommand
  ) {
    throw new Error("JuPedSim build provenance differs from the package lock");
  }
  const geometry = createJuPedSimGeometry(scenario);
  return {
    engineId: "jupedsim_sfm_engine_v1",
    engineAdapterVersion: JUPEDSIM_SFM_ADAPTER_VERSION,
    correctionMode: "native_none",
    commandVelocityMeaning:
      "final native JuPedSim SocialForceModel velocity after two deterministic internal substeps; realized velocity is displacement over the common experiment timestep",
    thirdPartyLockSha256: lockSha256(),
    upstreamProject: packageLock.project,
    upstreamRepository: packageLock.repository,
    upstreamCommit: null,
    upstreamLicense: packageLock.license,
    runnerPath: runner,
    runnerSha256: build.runnerSha256.jupedsim,
    buildManifestSha256: sha256File(BUILD_MANIFEST_PATH),
    engineSpecificProvenance: {
      jupedsimVersion: packageLock.version,
      pythonVersion: build.jupedsimPythonVersion,
      platform: build.platform,
      wheelFilename: packageLock.wheelFilename,
      packageWheelSha256: packageLock.wheelSha256,
      requirementsLockSha256: packageLock.requirementsLockSha256,
      installationCommand: packageLock.installationCommand,
      methodConfigSha256: sha256Bytes(serializeCanonicalMethodConfig(method)),
      geometrySha256: geometry.sha256,
      correctionMode: "native_none",
      directSteering: true,
      directSteeringJourneyStageCount: 1,
      exactDt: scenario.simulation.dt,
      experimentDt: scenario.simulation.dt,
      nativeJuPedSimDt: scenario.simulation.dt / 2,
      nativeSubstepsPerExperimentStep: 2,
      internalIntegrationDescription:
        "deterministic internal integration substepping for numerical stability of the stiff contact-force model",
      scenarioProvidedRadii: scenario.agents.map((agent) => ({
        id: agent.id,
        radius: agent.radius,
      })),
      scenarioProvidedPreferredSpeeds: scenario.agents.map((agent) => ({
        id: agent.id,
        preferredSpeed: agent.preferredSpeed,
      })),
      completionProtocolVersion: "completion-v2",
      completionSpecVersion: scenario.completion.completionSpecVersion,
      nativeGeometryAwareWayfinding: true,
    },
    limitations: [
      "Direct steering uses JuPedSim geometry-aware shortest-path wayfinding to the shared protocol target.",
      "The package-default SocialForceModel force coefficients are untuned for these scenarios.",
      "Each common experiment step uses two deterministic half-step native JuPedSim iterations; paper metrics sample only the common outer-step records.",
    ],
  };
}

function assertPinnedSource(entry: ReturnType<typeof dependency>): void {
  const source = repositoryPath(entry.sourceDirectory);
  if (!existsSync(source) || gitHead(source) !== entry.commit) {
    throw new Error(`${entry.project} source is missing or is not at its locked commit`);
  }
  const gitArguments = ["-c", `safe.directory=${source.replaceAll("\\", "/")}`, "-C", source];
  const untracked = command("git", [...gitArguments, "ls-files", "--others", "--exclude-standard"], { capture: true });
  if (untracked !== "") throw new Error(`${entry.project} source contains unexpected untracked files`);
  const changedPaths = command("git", [...gitArguments, "diff", "--name-only", "HEAD"], { capture: true })
    .split(/\r?\n/u)
    .filter(Boolean)
    .sort();
  const expectedPaths = entry.patch === null
    ? []
    : [...readFileSync(repositoryPath(entry.patch.path), "utf8").matchAll(/^\+\+\+ b\/(.+)$/gmu)]
      .map((match) => match[1])
      .sort();
  if (JSON.stringify(changedPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error(`${entry.project} source tree differs from the locked source plus patch`);
  }
  if (entry.patch !== null) {
    const patchPath = repositoryPath(entry.patch.path);
    if (sha256File(patchPath) !== entry.patch.sha256) {
      throw new Error(`${entry.project} patch differs from the third-party lock`);
    }
    command("git", [...gitArguments, "apply", "--reverse", "--check", patchPath], { capture: true });
  }
}

export function baselineRuntimePaths() {
  const lock = readThirdPartyLock();
  return {
    repositoryRoot: REPOSITORY_ROOT,
    orcaRunner: orcaRunnerPath(lock),
    python: pythonExecutable(lock),
    socialRunner: repositoryPath(lock.runners.socialForce),
    rvoSource: repositoryPath(dependency(lock, "rvo2").sourceDirectory),
    socialSource: repositoryPath(dependency(lock, "pysocialforce").sourceDirectory),
    jupedsimPython: jupedSimPythonExecutable(lock),
    jupedsimRunner: jupedSimRunnerPath(lock),
    jupedsimWheel: jupedSimWheelPath(lock),
  };
}
