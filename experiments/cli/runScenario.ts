import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SimulatorCore, CORRECTION_RATIO_EPSILON_METERS } from "../../src/core/SimulatorCore";
import type { StepDiagnostics } from "../../src/core/types";
import type { RunManifest, RunSummary, TrajectoryRecord } from "../output/types";
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

  const records: TrajectoryRecord[] = [];
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
    if (isRecordingStep || isLastStep) records.push(toTrajectoryRecord(diagnostic, states));
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

  mkdirSync(outputDirectory, { recursive: true });
  const manifestPath = resolve(outputDirectory, "manifest.json");
  const trajectoryPath = resolve(outputDirectory, "trajectory.jsonl");
  const summaryPath = resolve(outputDirectory, "summary.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeFileSync(
    trajectoryPath,
    records.length === 0 ? "" : `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return { manifestPath, trajectoryPath, summaryPath, summary };
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

function toTrajectoryRecord(diagnostic: StepDiagnostics, states: ReturnType<SimulatorCore["getAgents"]>): TrajectoryRecord {
  const targetById = new Map(diagnostic.perAgent.map((entry) => [entry.id, entry.targetVelocity]));
  return {
    stepIndex: diagnostic.stepIndex,
    time: diagnostic.time,
    agents: states.map((agent) => ({
      id: agent.id,
      position: agent.position,
      realizedVelocity: agent.velocity,
      targetVelocity: targetById.get(agent.id) ?? [0, 0],
      arrived: agent.arrived,
    })),
    diagnostics: {
      preCorrectionOverlapPairs: diagnostic.preCorrectionOverlapPairs,
      postCorrectionOverlapPairs: diagnostic.postCorrectionOverlapPairs,
      preCorrectionWallContacts: diagnostic.preCorrectionWallContacts,
      postCorrectionWallContacts: diagnostic.postCorrectionWallContacts,
      maxPreCorrectionPenetration: diagnostic.maxPreCorrectionPenetration,
      maxPostCorrectionPenetration: diagnostic.maxPostCorrectionPenetration,
      intendedDisplacement: diagnostic.intendedDisplacement,
      agentCorrectionDisplacement: diagnostic.agentCorrectionDisplacement,
      wallCorrectionDisplacement: diagnostic.wallCorrectionDisplacement,
      totalCorrectionDisplacement: diagnostic.totalCorrectionDisplacement,
      correctionRatio: diagnostic.correctionRatio,
      coincidentNeighborContributionsSkipped: diagnostic.coincidentNeighborContributionsSkipped,
    },
  };
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
