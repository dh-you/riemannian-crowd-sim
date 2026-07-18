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
import { SimulatorCore, CORRECTION_RATIO_EPSILON_METERS } from "../../src/core/SimulatorCore";
import { toTrajectoryRecord } from "../output/trajectory";
import type { RunManifest, RunSummary } from "../output/types";
import { parseScenario, type Scenario } from "../schema/scenario";

export interface RunScenarioOptions {
  scenarioPath: string;
  outputDirectory: string;
  recordingInterval?: number;
  commandArguments?: readonly string[];
}

export interface RunScenarioResult {
  manifestPath: string;
  trajectoryPath: string;
  summaryPath: string;
  summary: RunSummary;
}

export function fixedStepCount(horizonSeconds: number, dt: number): number {
  const ratio = horizonSeconds / dt;
  const nearestInteger = Math.round(ratio);
  if (Math.abs(ratio - nearestInteger) <= 1e-12 * Math.max(1, Math.abs(ratio))) {
    return nearestInteger;
  }
  return Math.floor(ratio);
}

export function runScenario(options: RunScenarioOptions): RunScenarioResult {
  const scenarioPath = resolve(options.scenarioPath);
  const outputDirectory = resolve(options.outputDirectory);
  mkdirSync(outputDirectory, { recursive: true });
  const manifestPath = resolve(outputDirectory, "manifest.json");
  const trajectoryPath = resolve(outputDirectory, "trajectory.jsonl");
  const temporaryTrajectoryPath = resolve(outputDirectory, "trajectory.jsonl.tmp");
  const summaryPath = resolve(outputDirectory, "summary.json");
  // Remove trajectory names first so a preparation failure cannot expose stale run data.
  const outputArtifacts = [trajectoryPath, temporaryTrajectoryPath, manifestPath, summaryPath];
  for (const path of outputArtifacts) rmSync(path, { force: true });

  let trajectoryDescriptor: number | undefined;
  let finalized = false;
  let failure: unknown;
  let result: RunScenarioResult | undefined;
  try {
    const scenario = loadScenario(scenarioPath);
    const recordingInterval = options.recordingInterval ?? scenario.simulation.recordingInterval ?? 1;
    if (!Number.isSafeInteger(recordingInterval) || recordingInterval < 1) {
      throw new Error("Recording interval must be a positive integer");
    }
    const totalSteps = fixedStepCount(scenario.simulation.horizonSeconds, scenario.simulation.dt);
    const simulator = new SimulatorCore({
      agents: scenario.agents,
      walls: scenario.walls,
      simulation: scenario.simulation,
      controller: scenario.controller,
    });

    trajectoryDescriptor = openSync(temporaryTrajectoryPath, "w");
    let minimumPreCorrectionClearance: number | null = null;
    let totalPreCorrectionOverlapExposure = 0;
    let totalPostCorrectionOverlapExposure = 0;
    let totalPreCorrectionPenetrationExposure = 0;
    let totalPostCorrectionPenetrationExposure = 0;
    let totalPreCorrectionWallPenetrationExposure = 0;
    let totalPostCorrectionWallPenetrationExposure = 0;
    let totalIntendedDisplacement = 0;
    let totalAgentCorrectionDisplacement = 0;
    let totalWallCorrectionDisplacement = 0;
    let nonFiniteValueOccurred = false;

    let trajectoryWriteFailure: unknown;
    try {
      for (let step = 0; step < totalSteps; step += 1) {
        const diagnostic = simulator.step();
        const states = simulator.getAgents();
        nonFiniteValueOccurred ||= containsNonFinite(diagnostic) || containsNonFinite(states);
        if (diagnostic.minimumPreCorrectionClearance !== null) {
          minimumPreCorrectionClearance =
            minimumPreCorrectionClearance === null
              ? diagnostic.minimumPreCorrectionClearance
              : Math.min(minimumPreCorrectionClearance, diagnostic.minimumPreCorrectionClearance);
        }
        const dt = scenario.simulation.dt;
        totalPreCorrectionOverlapExposure += diagnostic.preCorrectionOverlapPairs * dt;
        totalPostCorrectionOverlapExposure += diagnostic.postCorrectionOverlapPairs * dt;
        totalPreCorrectionPenetrationExposure += diagnostic.totalPreCorrectionOverlapPenetration * dt;
        totalPostCorrectionPenetrationExposure += diagnostic.totalPostCorrectionOverlapPenetration * dt;
        totalPreCorrectionWallPenetrationExposure += diagnostic.totalPreCorrectionWallPenetration * dt;
        totalPostCorrectionWallPenetrationExposure += diagnostic.totalPostCorrectionWallPenetration * dt;
        totalIntendedDisplacement += diagnostic.intendedDisplacement;
        totalAgentCorrectionDisplacement += diagnostic.agentCorrectionDisplacement;
        totalWallCorrectionDisplacement += diagnostic.wallCorrectionDisplacement;

        const isRecordingStep = (diagnostic.stepIndex + 1) % recordingInterval === 0;
        const isLastStep = diagnostic.stepIndex + 1 === totalSteps;
        if (isRecordingStep || isLastStep) {
          writeFileSync(
            trajectoryDescriptor,
            `${JSON.stringify(toTrajectoryRecord(diagnostic, states))}\n`,
            "utf8",
          );
        }
      }
    } catch (error) {
      trajectoryWriteFailure = error;
      throw error;
    } finally {
      const descriptor = trajectoryDescriptor;
      trajectoryDescriptor = undefined;
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch (closeError) {
          if (trajectoryWriteFailure === undefined) throw closeError;
        }
      }
    }

    const finalStates = simulator.getAgents();
    const arrivedAgents = finalStates.filter((agent) => agent.arrived).length;
    const totalCorrectionDisplacement =
      totalAgentCorrectionDisplacement + totalWallCorrectionDisplacement;
    const summary: RunSummary = {
      scenarioName: scenario.name,
      totalSteps,
      simulatedDuration: totalSteps * scenario.simulation.dt,
      arrivedAgents,
      arrivedFraction: finalStates.length === 0 ? 0 : arrivedAgents / finalStates.length,
      minimumPreCorrectionClearance,
      totalPreCorrectionOverlapExposure,
      totalPostCorrectionOverlapExposure,
      totalPreCorrectionPenetrationExposure,
      totalPostCorrectionPenetrationExposure,
      totalPreCorrectionWallPenetrationExposure,
      totalPostCorrectionWallPenetrationExposure,
      totalIntendedDisplacement,
      totalAgentCorrectionDisplacement,
      totalWallCorrectionDisplacement,
      totalCorrectionDisplacement,
      totalCorrectionRatio:
        totalCorrectionDisplacement / (totalIntendedDisplacement + CORRECTION_RATIO_EPSILON_METERS),
      nonFiniteValueOccurred: nonFiniteValueOccurred || containsNonFinite(finalStates),
      perAgentFinalState: finalStates,
    };
    if (containsNonFinite(summary)) {
      throw new Error("Simulation summary contains a non-finite value");
    }

    const manifest: RunManifest = {
      scenarioName: scenario.name,
      scenarioSchemaVersion: scenario.schemaVersion,
      controllerId: scenario.controller.id,
      controllerParameters: scenario.controller,
      timestepSeconds: scenario.simulation.dt,
      horizonSeconds: scenario.simulation.horizonSeconds,
      seed: scenario.seed,
      nodeVersion: process.version,
      operatingSystem: platform(),
      architecture: arch(),
      gitCommitSha: readGitCommit(dirname(scenarioPath)),
      executionTimestamp: new Date().toISOString(),
      commandArguments: [...(options.commandArguments ?? process.argv.slice(2))],
      recordingInterval,
    };

    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    renameSync(temporaryTrajectoryPath, trajectoryPath);
    finalized = true;
    result = { manifestPath, trajectoryPath, summaryPath, summary };
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
    if (!finalized) {
      for (const path of outputArtifacts) removeFilePreservingPrimaryError(path);
    }
  }

  if (failure !== undefined) throw failure;
  if (result === undefined) throw new Error("Scenario run ended without a result");
  return result;
}

function removeFilePreservingPrimaryError(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Cleanup is best-effort and must not replace the original run failure.
  }
}

function loadScenario(path: string): Scenario {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Failed to read scenario ${path}: ${errorMessage(error)}`);
  }
  return parseScenario(parsed);
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

function containsNonFinite(value: unknown): boolean {
  if (typeof value === "number") return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some(containsNonFinite);
  if (value !== null && typeof value === "object") return Object.values(value).some(containsNonFinite);
  return false;
}

function parseArguments(arguments_: readonly string[]): RunScenarioOptions {
  let scenarioPath: string | undefined;
  let outputDirectory: string | undefined;
  let recordingInterval: number | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (argument === "--scenario" && value !== undefined) {
      scenarioPath = value;
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
  if (outputDirectory === undefined) throw new Error("Missing required --out directory");
  return { scenarioPath, outputDirectory, recordingInterval, commandArguments: arguments_ };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function main(): void {
  try {
    const result = runScenario(parseArguments(process.argv.slice(2)));
    console.log(`core:run wrote ${result.summary.totalSteps} steps to ${dirname(result.summaryPath)}`);
  } catch (error) {
    console.error(`core:run failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) main();
