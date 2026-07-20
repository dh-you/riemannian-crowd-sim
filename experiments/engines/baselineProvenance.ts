import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sha256File } from "../protocol/hash";
import {
  BUILD_MANIFEST_PATH,
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
  socialForceRadiusAdaptationPath,
  socialForceRadiusRunnerPath,
} from "../baselines/common/thirdParty";
import {
  ORCA_ADAPTER_VERSION,
  SOCIAL_FORCE_ADAPTER_VERSION,
  SOCIAL_FORCE_RADIUS_ADAPTER_VERSION,
  type EngineProvenance,
} from "./ExperimentEngine";

export const SOCIAL_FORCE_RADIUS_DISTANCE_CONVENTION =
  "surface_clearance = center_distance - radius_i - radius_j";

export function baselineProvenance(
  kind: "orca" | "pysocialforce" | "pysocialforce_radius",
  frozenParameters?: Readonly<Record<string, number>>,
): EngineProvenance {
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
  const runner = kind === "orca"
    ? orcaRunnerPath(lock)
    : kind === "pysocialforce_radius"
      ? socialForceRadiusRunnerPath()
      : repositoryPath(lock.runners.socialForce);
  const expectedRunnerHash = kind === "orca"
    ? build.runnerSha256.orca
    : kind === "pysocialforce_radius"
      ? build.runnerSha256.radiusSocialForce
      : build.runnerSha256.socialForce;
  if (expectedRunnerHash === undefined) {
    throw new Error("Radius-aware PySocialForce runner is absent from build provenance");
  }
  if (!existsSync(runner) || sha256File(runner) !== expectedRunnerHash) {
    throw new Error(`Baseline runner is missing or stale: ${runner}`);
  }
  if (kind !== "orca" && !existsSync(pythonExecutable(lock))) {
    throw new Error("PySocialForce environment is missing; run npm run baselines:bootstrap");
  }
  const common: EngineProvenance = {
    engineId: kind === "orca"
      ? "orca_rvo2_engine_v1"
      : kind === "pysocialforce_radius"
        ? "pysocialforce_radius_engine_v2"
        : "pysocialforce_engine_v1",
    engineAdapterVersion:
      kind === "orca"
        ? ORCA_ADAPTER_VERSION
        : kind === "pysocialforce_radius"
          ? SOCIAL_FORCE_RADIUS_ADAPTER_VERSION
          : SOCIAL_FORCE_ADAPTER_VERSION,
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
    limitations:
      kind === "pysocialforce"
        ? ["Pinned PySocialForce supports one scene-wide pedestrian radius; heterogeneous-radius scenarios are rejected."]
        : kind === "pysocialforce_radius"
          ? [
            "Pedestrian-pedestrian forces use per-agent radii; the unchanged upstream obstacle force retains one scene-wide agent radius.",
            "No positional projection, contact force, friction, spring, saturation, or other stabilization is added.",
          ]
          : ["RVO2 uses single-precision arithmetic; cross-compiler last-bit variation may occur."],
  };
  if (kind !== "pysocialforce_radius") return common;
  if (frozenParameters === undefined) {
    throw new Error("Radius-aware PySocialForce provenance requires frozen parameters");
  }
  const adaptationSourcePath = socialForceRadiusAdaptationPath();
  return {
    ...common,
    radiusAware: true,
    distanceConvention: SOCIAL_FORCE_RADIUS_DISTANCE_CONVENTION,
    upstreamVersion: readPySocialForceVersion(repositoryPath(entry.sourceDirectory)),
    frozenParameters: { ...frozenParameters },
    adaptationSourcePath,
    adaptationSourceSha256: sha256File(adaptationSourcePath),
    implementationCommit: gitHead(REPOSITORY_ROOT),
  };
}

function readPySocialForceVersion(sourceDirectory: string): string {
  const source = readFileSync(resolve(sourceDirectory, "pysocialforce", "__init__.py"), "utf8");
  const match = source.match(/^__version__\s*=\s*["']([^"']+)["']/mu);
  if (match === null) throw new Error("Pinned PySocialForce version is missing");
  return match[1];
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
    socialRadiusRunner: socialForceRadiusRunnerPath(),
    rvoSource: repositoryPath(dependency(lock, "rvo2").sourceDirectory),
    socialSource: repositoryPath(dependency(lock, "pysocialforce").sourceDirectory),
  };
}
