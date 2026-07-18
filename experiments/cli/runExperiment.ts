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
import { controllerLabel } from "../../src/core/controllerFactory";
import { SimulatorCore } from "../../src/core/SimulatorCore";
import type { AgentState } from "../../src/core/types";
import { RunMetricsAccumulator } from "../metrics/RunMetricsAccumulator";
import type { RunMetrics } from "../metrics/types";
import { toTrajectoryRecord } from "../output/trajectory";
import { sha256Bytes } from "../protocol/hash";
import { identifyMethod } from "../protocol/methodIdentity";
import {
  controllerParametersFromMethod,
  parseMethodConfig,
  type MethodConfig,
} from "../protocol/methodConfig";
import { parseExperimentScenario, type ExperimentScenario } from "../protocol/schema";
import { fixedStepCount } from "./runScenario";

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
  scenarioName: string;
  family: string;
  variant: string;
  split: string;
  seed: number;
  controllerId: string;
  controllerLabel: string;
  methodKey: string;
  methodParameters: MethodConfig["parameters"];
  velocityTimeConstant: number;
  timestepSeconds: number;
  horizonSeconds: number;
  correction: ExperimentScenario["simulation"]["correction"];
  scenarioSha256: string;
  methodConfigSha256: string;
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
  arrivedAgents: number;
  arrivedFraction: number;
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

  const finalPaths = {
    manifest: resolve(outputDirectory, "manifest.json"),
    trajectory: resolve(outputDirectory, "trajectory.jsonl"),
    summary: resolve(outputDirectory, "summary.json"),
    metrics: resolve(outputDirectory, "run-metrics.json"),
  };
  const temporaryPaths = {
    manifest: `${finalPaths.manifest}.tmp`,
    trajectory: `${finalPaths.trajectory}.tmp`,
    summary: `${finalPaths.summary}.tmp`,
    metrics: `${finalPaths.metrics}.tmp`,
  };
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
    const methodIdentity = identifyMethod(method, methodBytes);
    const recordingInterval = options.recordingInterval ?? 1;
    if (!Number.isSafeInteger(recordingInterval) || recordingInterval < 1) {
      throw new Error("Recording interval must be a positive integer");
    }
    const totalSteps = fixedStepCount(
      scenario.simulation.horizonSeconds,
      scenario.simulation.dt,
    );
    const simulator = new SimulatorCore({
      agents: scenario.agents,
      walls: scenario.walls,
      simulation: {
        dt: scenario.simulation.dt,
        goalTolerance: scenario.simulation.goalTolerance,
        velocityTimeConstant: method.velocityTimeConstant,
        correction: scenario.simulation.correction,
      },
      controller: controllerParametersFromMethod(method),
    });
    const accumulator = new RunMetricsAccumulator(scenario, {
      ...methodIdentity,
      velocityTimeConstant: method.velocityTimeConstant,
      methodParameters: { ...method.parameters },
    });
    trajectoryDescriptor = openSync(temporaryPaths.trajectory, "w");
    let streamFailure: unknown;
    try {
      for (let step = 0; step < totalSteps; step += 1) {
        const beforeStep = simulator.getAgents();
        const diagnostic = simulator.step();
        const afterStep = simulator.getAgents();
        accumulator.observeStep(beforeStep, diagnostic, afterStep);
        const shouldRecord =
          (diagnostic.stepIndex + 1) % recordingInterval === 0 ||
          diagnostic.stepIndex + 1 === totalSteps;
        if (shouldRecord) {
          writeFileSync(
            trajectoryDescriptor,
            `${JSON.stringify(toTrajectoryRecord(diagnostic, afterStep))}\n`,
            "utf8",
          );
        }
      }
    } catch (error) {
      streamFailure = error;
      throw error;
    } finally {
      const descriptor = trajectoryDescriptor;
      trajectoryDescriptor = undefined;
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch (closeError) {
          if (streamFailure === undefined) throw closeError;
        }
      }
    }

    const finalStates = simulator.getAgents();
    const metrics = accumulator.finish(finalStates);
    const arrivedAgents = finalStates.filter((agent) => agent.arrived).length;
    const summary: ExperimentRunSummary = {
      scenarioName: scenario.name,
      methodId: method.id,
      methodKey: methodIdentity.methodKey,
      totalSteps,
      simulatedDuration: totalSteps * scenario.simulation.dt,
      arrivedAgents,
      arrivedFraction: finalStates.length === 0 ? 0 : arrivedAgents / finalStates.length,
      nonFiniteValueOccurred: containsNonFinite(finalStates) || containsNonFinite(metrics),
      perAgentFinalState: finalStates,
    };
    if (containsNonFinite(summary) || summary.nonFiniteValueOccurred) {
      throw new Error("Experiment output contains a non-finite value");
    }
    const manifest: ExperimentManifest = {
      experimentScenarioVersion: scenario.experimentScenarioVersion,
      methodConfigVersion: method.methodConfigVersion,
      scenarioName: scenario.name,
      family: scenario.family,
      variant: scenario.variant,
      split: scenario.split,
      seed: scenario.seed,
      controllerId: method.id,
      controllerLabel: controllerLabel(method.id),
      methodKey: methodIdentity.methodKey,
      methodParameters: method.parameters,
      velocityTimeConstant: method.velocityTimeConstant,
      timestepSeconds: scenario.simulation.dt,
      horizonSeconds: scenario.simulation.horizonSeconds,
      correction: scenario.simulation.correction,
      scenarioSha256: sha256Bytes(scenarioBytes),
      methodConfigSha256: methodIdentity.methodConfigSha256,
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
    renameSync(temporaryPaths.manifest, finalPaths.manifest);
    renameSync(temporaryPaths.summary, finalPaths.summary);
    renameSync(temporaryPaths.metrics, finalPaths.metrics);
    renameSync(temporaryPaths.trajectory, finalPaths.trajectory);
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
      try {
        closeSync(trajectoryDescriptor);
      } catch (cleanupError) {
        if (failure === undefined) failure = cleanupError;
      }
    }
    if (!finalized) for (const path of allArtifacts) removePreservingFailure(path);
  }
  if (failure !== undefined) throw failure;
  if (result === undefined) throw new Error("Experiment run ended without a result");
  return result;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function removePreservingFailure(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Preserve the primary simulation or I/O failure.
  }
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
  } catch {
    return null;
  }
}

function parseArguments(arguments_: readonly string[]): RunExperimentOptions {
  let scenarioPath: string | undefined;
  let methodPath: string | undefined;
  let outputDirectory: string | undefined;
  let recordingInterval: number | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (argument === "--scenario" && value !== undefined) {
      scenarioPath = value;
      index += 1;
    } else if (argument === "--method" && value !== undefined) {
      methodPath = value;
      index += 1;
    } else if (argument === "--out" && value !== undefined) {
      outputDirectory = value;
      index += 1;
    } else if (argument === "--record-every" && value !== undefined) {
      recordingInterval = Number(value);
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${argument}`);
    }
  }
  if (scenarioPath === undefined) throw new Error("Missing required --scenario path");
  if (methodPath === undefined) throw new Error("Missing required --method path");
  if (outputDirectory === undefined) throw new Error("Missing required --out directory");
  return {
    scenarioPath,
    methodPath,
    outputDirectory,
    recordingInterval,
    commandArguments: arguments_,
  };
}

function main(): void {
  try {
    const result = runExperiment(parseArguments(process.argv.slice(2)));
    console.log(
      `exp:run wrote ${result.summary.totalSteps} steps for ${result.manifest.controllerId} to ${dirname(result.summaryPath)}`,
    );
  } catch (error) {
    console.error(`exp:run failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) main();
