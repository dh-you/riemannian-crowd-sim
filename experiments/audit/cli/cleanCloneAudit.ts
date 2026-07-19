import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdtempSync } from "node:fs";
import { AUDIT_RESULTS_ROOT, writeJson } from "./auditUtils";
import { runFairnessAudit } from "./runFairnessAudit";
import { writeFinalAuditReport, type CommandResult } from "./runD0Audit";
import { sha256File } from "../../protocol/hash";
import type { BaselineBuildManifest } from "../../baselines/common/thirdParty";

interface CloneCommand {
  command: string;
  status: "PASS" | "FAIL";
  exitCode: number;
  logPath: string;
}

function run(
  name: "npm" | "git",
  arguments_: readonly string[],
  cwd: string,
  logPath: string,
): CloneCommand {
  const npmCli = process.env.npm_execpath;
  const executable = name === "npm" && npmCli !== undefined
    ? process.execPath
    : name === "npm" && process.platform === "win32" ? "npm.cmd" : name;
  const invocationArguments = name === "npm" && npmCli !== undefined ? [npmCli, ...arguments_] : [...arguments_];
  const result = spawnSync(executable, invocationArguments, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 20 * 60 * 1000,
  });
  const command = `${name} ${arguments_.join(" ")}`;
  writeFileSync(logPath, [`$ ${command}`, result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n"), "utf8");
  return { command, status: result.status === 0 ? "PASS" : "FAIL", exitCode: result.status ?? -1, logPath };
}

interface ReproductionComparison {
  methodId: string;
  identityMatch: boolean;
  stableManifestIdentityMatch: boolean;
  stableBuildIdentityMatch: boolean;
  originalProvenanceValid: boolean;
  cloneProvenanceValid: boolean;
  runnerHashByteMatch: boolean | null;
  buildManifestHashByteMatch: boolean | null;
  trajectoryByteMatch: boolean;
  metricsByteMatch: boolean;
}

function compareFairnessRuns(originalRoot: string, cloneRoot: string): { status: "PASS" | "FAIL"; comparisons: ReproductionComparison[]; firstFailure: ReproductionComparison | null } {
  const methods = [
    "conditioned_riemannian_metric_v1",
    "euclidean_goal_steering_v1",
    "orca_rvo2_v1",
    "social_force_pysocialforce_v1",
  ];
  const comparisons: ReproductionComparison[] = [];
  const originalRepository = resolve(originalRoot, "../../..");
  const cloneRepository = resolve(cloneRoot, "../../..");
  const originalBuild = readBuildManifestForAudit(originalRepository);
  const cloneBuild = readBuildManifestForAudit(cloneRepository);
  const stableBuildIdentityMatch = JSON.stringify(stableBuildIdentity(originalBuild)) ===
    JSON.stringify(stableBuildIdentity(cloneBuild));
  for (const methodId of methods) {
    const original = resolve(originalRoot, methodId);
    const cloned = resolve(cloneRoot, methodId);
    const originalManifest = JSON.parse(readFileSync(resolve(original, "audit-manifest.json"), "utf8")) as Record<string, unknown>;
    const cloneManifest = JSON.parse(readFileSync(resolve(cloned, "audit-manifest.json"), "utf8")) as Record<string, unknown>;
    const identityFields = ["scenarioSha256", "methodIdentityVersion", "methodKey", "methodConfigCanonicalSha256", "methodConfigSourceSha256", "engineId", "engineAdapterVersion", "correctionMode", "thirdPartyLockSha256", "upstreamCommit"];
    const stableManifestIdentityMatch = identityFields.every((field) => originalManifest[field] === cloneManifest[field]);
    const external = methodId === "orca_rvo2_v1" || methodId === "social_force_pysocialforce_v1";
    const runnerKind = methodId === "orca_rvo2_v1" ? "orca" : "socialForce";
    const originalProvenanceValid = !external || localBuildProvenanceIsValid(
      originalRepository,
      originalManifest,
      originalBuild,
      runnerKind,
    );
    const cloneProvenanceValid = !external || localBuildProvenanceIsValid(
      cloneRepository,
      cloneManifest,
      cloneBuild,
      runnerKind,
    );
    const runnerHashByteMatch = external
      ? originalManifest.runnerSha256 === cloneManifest.runnerSha256
      : null;
    const buildManifestHashByteMatch = external
      ? originalManifest.buildManifestSha256 === cloneManifest.buildManifestSha256
      : null;
    const trajectoryByteMatch = Buffer.compare(readFileSync(resolve(original, "engine-steps.jsonl")), readFileSync(resolve(cloned, "engine-steps.jsonl"))) === 0;
    const metricsByteMatch = Buffer.compare(readFileSync(resolve(original, "run-metrics.json")), readFileSync(resolve(cloned, "run-metrics.json"))) === 0;
    const identityMatch = stableManifestIdentityMatch && (!external || (
      stableBuildIdentityMatch && originalProvenanceValid && cloneProvenanceValid
    ));
    comparisons.push({
      methodId,
      identityMatch,
      stableManifestIdentityMatch,
      stableBuildIdentityMatch: !external || stableBuildIdentityMatch,
      originalProvenanceValid,
      cloneProvenanceValid,
      runnerHashByteMatch,
      buildManifestHashByteMatch,
      trajectoryByteMatch,
      metricsByteMatch,
    });
  }
  const firstFailure = comparisons.find((entry) => !entry.identityMatch || !entry.trajectoryByteMatch || !entry.metricsByteMatch) ?? null;
  return { status: firstFailure === null ? "PASS" : "FAIL", comparisons, firstFailure };
}

function readBuildManifestForAudit(repositoryRoot: string): BaselineBuildManifest {
  return JSON.parse(readFileSync(
    resolve(repositoryRoot, "experiments", "third_party", "build", "build-manifest.json"),
    "utf8",
  )) as BaselineBuildManifest;
}

function stableBuildIdentity(manifest: BaselineBuildManifest): unknown {
  return {
    buildManifestVersion: manifest.buildManifestVersion,
    lockSha256: manifest.lockSha256,
    adapterSourceSha256: manifest.adapterSourceSha256,
    upstreamCommits: manifest.upstreamCommits,
    compiler: manifest.compiler,
    cmake: manifest.cmake,
    buildType: manifest.buildType,
    openMpEnabled: manifest.openMpEnabled,
    pythonVersion: manifest.pythonVersion,
    pythonPackages: manifest.pythonPackages,
    platform: manifest.platform,
    architecture: manifest.architecture,
    socialForceRunnerSha256: manifest.runnerSha256.socialForce,
  };
}

function localBuildProvenanceIsValid(
  repositoryRoot: string,
  runManifest: Record<string, unknown>,
  buildManifest: BaselineBuildManifest,
  runnerKind: "orca" | "socialForce",
): boolean {
  const buildManifestPath = resolve(
    repositoryRoot,
    "experiments",
    "third_party",
    "build",
    "build-manifest.json",
  );
  const runnerPath = buildManifest.runners[runnerKind];
  return runManifest.buildManifestSha256 === sha256File(buildManifestPath) &&
    runManifest.runnerSha256 === buildManifest.runnerSha256[runnerKind] &&
    existsSync(runnerPath) && sha256File(runnerPath) === buildManifest.runnerSha256[runnerKind];
}

function safeRemoveClone(temporaryRoot: string, cloneRoot: string): void {
  const realTemporary = realpathSync(temporaryRoot);
  const realClone = realpathSync(cloneRoot);
  const relation = relative(realTemporary, realClone);
  if (relation === "" || relation === ".." || relation.startsWith(`..${sep}`) || resolve(realClone) === resolve(tmpdir())) {
    throw new Error(`Refusing to remove unsafe clean-clone path: ${realClone}`);
  }
  rmSync(realClone, { recursive: true, force: true });
  rmSync(realTemporary, { recursive: true, force: true });
}

export function runCleanCloneAudit(): { status: "PASS"; reportPath: string } {
  const repositoryRoot = resolve(".");
  const status = spawnSync("git", ["status", "--short"], { cwd: repositoryRoot, encoding: "utf8" });
  if (status.status !== 0 || status.stdout.trim().length > 0) throw new Error("Clean-clone audit requires a clean tracked worktree");
  runFairnessAudit();
  const temporaryRoot = mkdtempSync(join(tmpdir(), "riemannian-d0-"));
  const cloneRoot = resolve(temporaryRoot, "clean-clone");
  const logRoot = resolve(AUDIT_RESULTS_ROOT, "clean-clone-logs");
  mkdirSync(logRoot, { recursive: true });
  const commands: CloneCommand[] = [];
  const clone = run("git", ["clone", "--no-local", repositoryRoot, cloneRoot], repositoryRoot, resolve(logRoot, "00-clone.log"));
  commands.push(clone);
  if (clone.status === "PASS") {
    const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).stdout.trim();
    commands.push(run("git", ["checkout", "--detach", commit], cloneRoot, resolve(logRoot, "01-checkout.log")));
  }
  const npmCommands: readonly (readonly string[])[] = [
    ["ci"],
    ["run", "build"],
    ["test"],
    ["run", "baselines:bootstrap"],
    ["run", "baselines:build"],
    ["run", "baselines:verify"],
    ["run", "test:baselines"],
    ["run", "core:smoke"],
    ["run", "exp:smoke"],
    ["run", "baselines:smoke"],
    ["run", "audit:metrics"],
    ["run", "audit:riemannian"],
    ["run", "audit:fairness"],
  ];
  if (commands.every((entry) => entry.status === "PASS")) {
    for (const [index, arguments_] of npmCommands.entries()) {
      const result = run("npm", arguments_, cloneRoot, resolve(logRoot, `${(index + 2).toString().padStart(2, "0")}-${arguments_.join("-").replaceAll(":", "-")}.log`));
      commands.push(result);
      console.log(`${result.status} clean clone: ${result.command}`);
      if (result.status === "FAIL") break;
    }
  }
  let comparison: ReturnType<typeof compareFairnessRuns> | null = null;
  if (commands.every((entry) => entry.status === "PASS")) {
    comparison = compareFairnessRuns(resolve(AUDIT_RESULTS_ROOT, "fairness"), resolve(cloneRoot, "results", "stage-d0-audit", "fairness"));
  }
  const firstCommandFailure = commands.find((entry) => entry.status === "FAIL") ?? null;
  const reportPath = resolve(AUDIT_RESULTS_ROOT, "clean-clone-report.json");
  const report = {
    cleanCloneAuditVersion: 1,
    status: firstCommandFailure === null && comparison?.status === "PASS" ? "PASS" : "FAIL",
    sourceRepository: repositoryRoot,
    auditedCommit: spawnSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).stdout.trim(),
    clonePath: firstCommandFailure === null && comparison?.status === "PASS" ? null : cloneRoot,
    commands,
    comparison,
    firstFailure: firstCommandFailure ?? comparison?.firstFailure ?? null,
    excludedLocalState: ["experiments/third_party", "node_modules", "results", "experiments/generated"],
  };
  writeJson(reportPath, report);
  const existingReportPath = resolve(AUDIT_RESULTS_ROOT, "report.json");
  const previousCommands = existsSync(existingReportPath)
    ? ((JSON.parse(readFileSync(existingReportPath, "utf8")) as { commandResults?: CommandResult[] }).commandResults ?? [])
    : [];
  writeFinalAuditReport(previousCommands);
  if (report.status !== "PASS") throw new Error(`Clean-clone audit failed; preserved clone at ${cloneRoot}; see ${reportPath}`);
  safeRemoveClone(temporaryRoot, cloneRoot);
  return { status: "PASS", reportPath };
}

function main(): void {
  try {
    const result = runCleanCloneAudit();
    console.log(`audit:clean-clone passed; report ${basename(result.reportPath)}`);
  } catch (error) {
    console.error(`audit:clean-clone failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) main();
