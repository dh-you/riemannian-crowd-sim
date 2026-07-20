import { execFileSync } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { arch, platform } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentState } from "../../src/core/types";
import { createExperimentEngine } from "../engines/factory";
import type { EngineProvenance } from "../engines/ExperimentEngine";
import { RunMetricsAccumulator } from "../metrics/RunMetricsAccumulator";
import type { RunMetrics } from "../metrics/types";
import { engineStepToTrajectoryRecord } from "../output/trajectory";
import { sha256Bytes } from "../protocol/hash";
import { identifyMethod } from "../protocol/methodIdentity";
import {
  parseMethodConfig,
  velocityTimeConstantForMethod,
  type MethodConfig,
} from "../protocol/methodConfig";
import { parseExperimentScenario, type ExperimentScenario } from "../protocol/schema";

export interface RunExperimentOptions {
  scenarioPath: string;
  methodPath: string;
  outputDirectory: string;
  recordingInterval?: number;
  commandArguments?: readonly string[];
}

export interface ExperimentManifest {
  experimentScenarioVersion: number;
  methodConfigVersion: number;
  methodIdentityVersion: number;
  scenarioName: string;
  family: string;
  variant: string;
  split: string;
  seed: number;
  controllerId: string;
  controllerLabel: string;
  engineId: string;
  engineAdapterVersion: string;
  correctionMode: string;
  commandVelocityMeaning: string;
  methodKey: string;
  methodParameters: MethodConfig["parameters"];
  velocityTimeConstant: number | null;
  timestepSeconds: number;
  horizonSeconds: number;
  correction: ExperimentScenario["simulation"]["correction"];
  completion: ExperimentScenario["completion"];
  navigation: ExperimentScenario["navigation"];
  scenarioSha256: string;
  methodConfigCanonicalSha256: string;
  methodConfigSourceSha256: string;
  /** @deprecated Identity-v2 alias for canonical SHA-256. */
  methodConfigSha256: string;
  thirdPartyLockSha256: string | null;
  upstreamProject: string | null;
  upstreamRepository: string | null;
  upstreamCommit: string | null;
  upstreamLicense: string | null;
  runnerPath: string | null;
  runnerSha256: string | null;
  buildManifestSha256: string | null;
  implementationLimitations: string[];
  gitCommitSha: string | null;
  nodeVersion: string;
  operatingSystem: string;
  architecture: string;
  commandArguments: string[];
  executionTimestamp: string;
  recordingInterval: number;
}

export interface ExperimentRunSummary {
  scenarioName: string;
  methodId: string;
  methodKey: string;
  totalSteps: number;
  simulatedDuration: number;
  completedAgents: number;
  completionFraction: number;
  legacyFinalPointGoalArrivedAgents: number;
  legacyFinalPointGoalArrivedFraction: number;
  nonFiniteValueOccurred: boolean;
  perAgentFinalState: AgentState[];
}

export interface RunExperimentResult {
  manifestPath: string;
  trajectoryPath: string;
  summaryPath: string;
  metricsPath: string;
  manifest: ExperimentManifest;
  summary: ExperimentRunSummary;
  metrics: RunMetrics;
}

export function runExperiment(options: RunExperimentOptions): RunExperimentResult {
  const scenarioPath = resolve(options.scenarioPath);
  const methodPath = resolve(options.methodPath);
  const outputDirectory = resolve(options.outputDirectory);
  mkdirSync(outputDirectory, { recursive: true });
  const finalPaths = artifactPaths(outputDirectory, "");
  const temporaryPaths = artifactPaths(outputDirectory, ".tmp");
  const allArtifacts = [...Object.values(finalPaths), ...Object.values(temporaryPaths)];
  for (const path of allArtifacts) rmSync(path, { force: true });

  let trajectoryDescriptor: number | undefined;
  let finalized = false;
  let failure: unknown;
  let result: RunExperimentResult | undefined;
  try {
    const scenarioBytes = readFileSync(scenarioPath, "utf8");
    const methodBytes = readFileSync(methodPath, "utf8");
    const scenario = parseExperimentScenario(JSON.parse(scenarioBytes) as unknown);
    const method = parseMethodConfig(JSON.parse(methodBytes) as unknown);
    const identity = identifyMethod(method, methodBytes);
    const engine = createExperimentEngine(method, identity);
    const preliminaryProvenance = engine.getProvenance(scenario, method);
    const recordingInterval = options.recordingInterval ?? 1;
    if (!Number.isSafeInteger(recordingInterval) || recordingInterval < 1) {
      throw new Error("Recording interval must be a positive integer");
    }
    const accumulator = new RunMetricsAccumulator(scenario, {
      ...identity,
      velocityTimeConstant: velocityTimeConstantForMethod(method),
      methodParameters: { ...method.parameters },
      ...metricsProvenance(preliminaryProvenance),
    });
    trajectoryDescriptor = openSync(temporaryPaths.trajectory, "w");
    const engineResult = engine.run(scenario, method, identity, (record) => {
      accumulator.observeStep(record);
      const shouldRecord =
        (record.stepIndex + 1) % recordingInterval === 0 ||
        record.stepIndex + 1 === expectedStepCount(scenario);
      if (shouldRecord) {
        writeFileSync(
          trajectoryDescriptor as number,
          `${JSON.stringify(engineStepToTrajectoryRecord(record))}\n`,
          "utf8",
        );
      }
    });
    closeSync(trajectoryDescriptor);
    trajectoryDescriptor = undefined;
    assertSameProvenance(preliminaryProvenance, engineResult.provenance);

    const finalStates = engineResult.finalStates;
    const metrics = accumulator.finish(finalStates);
    const legacyFinalPointGoalArrivedAgents = finalStates.filter((agent) => agent.arrived).length;
    const summary: ExperimentRunSummary = {
      scenarioName: scenario.name,
      methodId: method.id,
      methodKey: identity.methodKey,
      totalSteps: engineResult.totalSteps,
      simulatedDuration: engineResult.totalSteps * scenario.simulation.dt,
      completedAgents: metrics.completion.completedAgents,
      completionFraction: metrics.completion.successFraction,
      legacyFinalPointGoalArrivedAgents,
      legacyFinalPointGoalArrivedFraction:
        finalStates.length === 0 ? 0 : legacyFinalPointGoalArrivedAgents / finalStates.length,
      nonFiniteValueOccurred: containsNonFinite(finalStates) || containsNonFinite(metrics),
      perAgentFinalState: finalStates,
    };
    if (containsNonFinite(summary) || summary.nonFiniteValueOccurred) {
      throw new Error("Experiment output contains a non-finite value");
    }
    const provenance = engineResult.provenance;
    const manifest: ExperimentManifest = {
      experimentScenarioVersion: scenario.experimentScenarioVersion,
      methodConfigVersion: method.methodConfigVersion,
      methodIdentityVersion: identity.methodIdentityVersion,
      scenarioName: scenario.name,
      family: scenario.family,
      variant: scenario.variant,
      split: scenario.split,
      seed: scenario.seed,
      controllerId: method.id,
      controllerLabel: methodLabel(method.id),
      engineId: provenance.engineId,
      engineAdapterVersion: provenance.engineAdapterVersion,
      correctionMode: provenance.correctionMode,
      commandVelocityMeaning: provenance.commandVelocityMeaning,
      methodKey: identity.methodKey,
      methodParameters: method.parameters,
      velocityTimeConstant: velocityTimeConstantForMethod(method),
      timestepSeconds: scenario.simulation.dt,
      horizonSeconds: scenario.simulation.horizonSeconds,
      correction: scenario.simulation.correction,
      completion: scenario.completion,
      navigation: scenario.navigation,
      scenarioSha256: sha256Bytes(scenarioBytes),
      methodConfigCanonicalSha256: identity.methodConfigCanonicalSha256,
      methodConfigSourceSha256: identity.methodConfigSourceSha256,
      methodConfigSha256: identity.methodConfigCanonicalSha256,
      thirdPartyLockSha256: provenance.thirdPartyLockSha256,
      upstreamProject: provenance.upstreamProject,
      upstreamRepository: provenance.upstreamRepository,
      upstreamCommit: provenance.upstreamCommit,
      upstreamLicense: provenance.upstreamLicense,
      runnerPath: provenance.runnerPath,
      runnerSha256: provenance.runnerSha256,
      buildManifestSha256: provenance.buildManifestSha256,
      implementationLimitations: provenance.limitations,
      gitCommitSha: readGitCommit(dirname(scenarioPath)),
      nodeVersion: process.version,
      operatingSystem: platform(),
      architecture: arch(),
      commandArguments: [...(options.commandArguments ?? process.argv.slice(2))],
      executionTimestamp: new Date().toISOString(),
      recordingInterval,
    };

    writeJson(temporaryPaths.manifest, manifest);
    writeJson(temporaryPaths.summary, summary);
    writeJson(temporaryPaths.metrics, metrics);
    for (const key of Object.keys(finalPaths) as (keyof typeof finalPaths)[]) {
      renameSync(temporaryPaths[key], finalPaths[key]);
    }
    finalized = true;
    result = {
      manifestPath: finalPaths.manifest,
      trajectoryPath: finalPaths.trajectory,
      summaryPath: finalPaths.summary,
      metricsPath: finalPaths.metrics,
      manifest,
      summary,
      metrics,
    };
  } catch (error) {
    failure = error;
  } finally {
    if (trajectoryDescriptor !== undefined) {
      try { closeSync(trajectoryDescriptor); } catch (cleanupError) { if (failure === undefined) failure = cleanupError; }
    }
    if (!finalized) for (const path of allArtifacts) removePreservingFailure(path);
  }
  if (failure !== undefined) throw failure;
  if (result === undefined) throw new Error("Experiment run ended without a result");
  return result;
}

function artifactPaths(outputDirectory: string, suffix: string) {
  return {
    manifest: resolve(outputDirectory, `manifest.json${suffix}`),
    trajectory: resolve(outputDirectory, `trajectory.jsonl${suffix}`),
    summary: resolve(outputDirectory, `summary.json${suffix}`),
    metrics: resolve(outputDirectory, `run-metrics.json${suffix}`),
  };
}

function metricsProvenance(provenance: EngineProvenance) {
  return {
    engineId: provenance.engineId,
    engineAdapterVersion: provenance.engineAdapterVersion,
    correctionMode: provenance.correctionMode,
    commandVelocityMeaning: provenance.commandVelocityMeaning,
    upstreamProject: provenance.upstreamProject,
    upstreamCommit: provenance.upstreamCommit,
    upstreamLicense: provenance.upstreamLicense,
  };
}

function assertSameProvenance(before: EngineProvenance, after: EngineProvenance): void {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error("Engine provenance changed during simulation");
  }
}

function expectedStepCount(scenario: ExperimentScenario): number {
  const ratio = scenario.simulation.horizonSeconds / scenario.simulation.dt;
  const nearest = Math.round(ratio);
  if (Math.abs(ratio - nearest) > 1e-9) throw new Error("Horizon must be an integer multiple of dt");
  return nearest;
}

function methodLabel(id: string): string {
  if (id === "conditioned_riemannian_metric_v1") return "Conditioned Riemannian";
  if (id === "euclidean_goal_steering_v1") return "Goal+Projection";
  if (id === "orca_rvo2_v1") return "ORCA/RVO2";
  if (id === "social_force_pysocialforce_v1") return "PySocialForce";
  return id;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function removePreservingFailure(path: string): void {
  try { rmSync(path, { force: true }); } catch { /* preserve primary failure */ }
}

function containsNonFinite(value: unknown): boolean {
  if (typeof value === "number") return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some(containsNonFinite);
  if (value !== null && typeof value === "object") return Object.values(value).some(containsNonFinite);
  return false;
}

function readGitCommit(startDirectory: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: startDirectory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch { return null; }
}

function parseArguments(arguments_: readonly string[]): RunExperimentOptions {
  let scenarioPath: string | undefined;
  let methodPath: string | undefined;
  let outputDirectory: string | undefined;
  let recordingInterval: number | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (argument === "--scenario" && value !== undefined) { scenarioPath = value; index += 1; }
    else if (argument === "--method" && value !== undefined) { methodPath = value; index += 1; }
    else if (argument === "--out" && value !== undefined) { outputDirectory = value; index += 1; }
    else if (argument === "--record-every" && value !== undefined) { recordingInterval = Number(value); index += 1; }
    else throw new Error(`Unknown or incomplete argument: ${argument}`);
  }
  if (scenarioPath === undefined) throw new Error("Missing required --scenario path");
  if (methodPath === undefined) throw new Error("Missing required --method path");
  if (outputDirectory === undefined) throw new Error("Missing required --out directory");
  return { scenarioPath, methodPath, outputDirectory, recordingInterval, commandArguments: arguments_ };
}

function main(): void {
  try {
    const result = runExperiment(parseArguments(process.argv.slice(2)));
    console.log(`exp:run wrote ${result.summary.totalSteps} steps for ${result.manifest.controllerId} to ${dirname(result.summaryPath)}`);
  } catch (error) {
    console.error(`exp:run failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) main();
