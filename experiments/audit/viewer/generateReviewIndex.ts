import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Vec2 } from "../../../src/core/types";
import type { EngineStepRecord } from "../../engines/engineStep";
import { validateEngineStepRecord } from "../../engines/engineStep";
import { forEachJsonLineSync } from "../../protocol/jsonLines";
import type { ExperimentScenario } from "../../protocol/schema";
import { parseExperimentScenario } from "../../protocol/schema";

const DEFAULT_AUDIT_ROOT = resolve("results/lean/audit");
const DEFAULT_OUTPUT_DIRECTORY = resolve(DEFAULT_AUDIT_ROOT, "trajectory-review");
const AVOIDANCE_ONSET_ANGLE_DEGREES = 5;

const METHOD_LABELS: Readonly<Record<string, string>> = {
  conditioned_riemannian_metric_v1: "Conditioned Riemannian",
  euclidean_goal_steering_v1: "Goal + Projection",
  orca_rvo2_v1: "ORCA / RVO2",
  social_force_pysocialforce_v1: "PySocialForce",
  social_force_jupedsim_v1: "JuPedSim SocialForceModel",
};

const METHOD_ORDER: Readonly<Record<string, number>> = {
  conditioned_riemannian_metric_v1: 0,
  euclidean_goal_steering_v1: 1,
  orca_rvo2_v1: 2,
  social_force_pysocialforce_v1: 3,
  social_force_jupedsim_v1: 4,
};

interface AuditManifest {
  scenarioPath: string;
  scenarioSha256: string;
  scenarioName: string;
  methodId: string;
  methodKey: string;
  engineId: string;
  correctionMode: string;
  commandVelocityMeaning: string;
}

export interface ClosestEncounter {
  stepIndex: number;
  time: number;
  firstAgentId: number;
  secondAgentId: number;
  centerDistance: number;
  physicalClearance: number;
  firstPreCorrectionPosition: Vec2;
  secondPreCorrectionPosition: Vec2;
  firstPostCorrectionPosition: Vec2;
  secondPostCorrectionPosition: Vec2;
}

export interface AvoidanceOnset {
  agentId: number;
  stepIndex: number;
  time: number;
  position: Vec2;
  deflectionDegrees: number;
}

interface ViewerRun {
  methodId: string;
  methodLabel: string;
  methodKey: string;
  engineId: string;
  correctionMode: string;
  commandVelocityMeaning: string;
  source: {
    manifest: string;
    trajectory: string;
    scenario: string;
  };
  closestPreCorrectionEncounter: ClosestEncounter | null;
  avoidanceOnsets: AvoidanceOnset[];
  frameDurationsSeconds: number[];
  steps: ViewerStep[];
}

interface ViewerStep {
  stepIndex: number;
  time: number;
  agents: Array<{
    id: number;
    preCorrectionPosition: Vec2;
    postCorrectionPosition: Vec2;
    arrived: boolean;
  }>;
}

interface ViewerScenarioGroup {
  key: string;
  scenarioSha256: string;
  scenario: ExperimentScenario;
  runs: ViewerRun[];
}

export interface ReviewIndexOptions {
  auditRoot?: string;
  outputDirectory?: string;
  trajectoryFilename?: string;
}

export interface ReviewIndexResult {
  indexPath: string;
  scenarioCount: number;
  runCount: number;
  stepCount: number;
}

export interface StoredStepTime {
  stepIndex: number;
  time: number;
}

/**
 * Returns one playback interval for each transition between retained records.
 * The final frame intentionally has no outgoing interval.
 */
export function computeStoredFrameDurations(
  steps: readonly StoredStepTime[],
): number[] {
  const durations: number[] = [];
  for (let index = 0; index + 1 < steps.length; index += 1) {
    const current = steps[index];
    const next = steps[index + 1];
    const duration = next.time - current.time;
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error(
        `Stored trajectory time difference must be positive and finite between records ${index} and ${index + 1} (steps ${current.stepIndex} and ${next.stepIndex}); received ${duration}`,
      );
    }
    durations.push(duration);
  }
  return durations;
}

export function computeStoredPlaybackDuration(
  steps: readonly StoredStepTime[],
): number {
  return computeStoredFrameDurations(steps)
    .reduce((total, duration) => total + duration, 0);
}

/** Finds the globally closest physical agent-agent encounter before correction. */
export function computeClosestPreCorrectionEncounter(
  scenario: ExperimentScenario,
  steps: readonly EngineStepRecord[],
): ClosestEncounter | null {
  const radii = new Map(scenario.agents.map((agent) => [agent.id, agent.radius]));
  let closest: ClosestEncounter | null = null;
  for (const step of steps) {
    for (let firstIndex = 0; firstIndex < step.agents.length; firstIndex += 1) {
      const first = step.agents[firstIndex];
      const firstRadius = radii.get(first.id);
      if (firstRadius === undefined) throw new Error(`Scenario is missing agent ${first.id}`);
      for (let secondIndex = firstIndex + 1; secondIndex < step.agents.length; secondIndex += 1) {
        const second = step.agents[secondIndex];
        const secondRadius = radii.get(second.id);
        if (secondRadius === undefined) throw new Error(`Scenario is missing agent ${second.id}`);
        const centerDistance = distance(first.preCorrectionPosition, second.preCorrectionPosition);
        const physicalClearance = centerDistance - firstRadius - secondRadius;
        if (closest !== null && physicalClearance >= closest.physicalClearance) continue;
        closest = {
          stepIndex: step.stepIndex,
          time: step.time,
          firstAgentId: first.id,
          secondAgentId: second.id,
          centerDistance,
          physicalClearance,
          firstPreCorrectionPosition: first.preCorrectionPosition,
          secondPreCorrectionPosition: second.preCorrectionPosition,
          firstPostCorrectionPosition: first.postCorrectionPosition,
          secondPostCorrectionPosition: second.postCorrectionPosition,
        };
      }
    }
  }
  return closest;
}

/**
 * Mirrors the D0 SVG audit's behavioral onset marker: the first native command
 * more than five degrees away from the direct goal direction.
 */
export function computeFirstAvoidanceOnsets(
  scenario: ExperimentScenario,
  steps: readonly EngineStepRecord[],
): AvoidanceOnset[] {
  const definitions = new Map(scenario.agents.map((agent) => [agent.id, agent]));
  const onsets = new Map<number, AvoidanceOnset>();
  for (const step of steps) {
    for (const agent of step.agents) {
      if (onsets.has(agent.id)) continue;
      const definition = definitions.get(agent.id);
      if (definition === undefined) throw new Error(`Scenario is missing agent ${agent.id}`);
      const goalVector: Vec2 = [
        agent.navigationTarget[0] - agent.positionBefore[0],
        agent.navigationTarget[1] - agent.positionBefore[1],
      ];
      const commandMagnitude = magnitude(agent.commandVelocity);
      const goalMagnitude = magnitude(goalVector);
      if (commandMagnitude === 0 || goalMagnitude === 0) continue;
      const cosine = clamp(
        dot(agent.commandVelocity, goalVector) / (commandMagnitude * goalMagnitude),
        -1,
        1,
      );
      const deflectionDegrees = Math.acos(cosine) * 180 / Math.PI;
      if (deflectionDegrees <= AVOIDANCE_ONSET_ANGLE_DEGREES) continue;
      onsets.set(agent.id, {
        agentId: agent.id,
        stepIndex: step.stepIndex,
        time: Math.max(0, step.time - scenario.simulation.dt),
        position: agent.positionBefore,
        deflectionDegrees,
      });
    }
  }
  return [...onsets.values()].sort((first, second) => first.agentId - second.agentId);
}

export function generateReviewIndex(options: ReviewIndexOptions = {}): ReviewIndexResult {
  const auditRoot = resolve(options.auditRoot ?? DEFAULT_AUDIT_ROOT);
  const outputDirectory = resolve(options.outputDirectory ?? DEFAULT_OUTPUT_DIRECTORY);
  const trajectoryFilename = options.trajectoryFilename ?? "engine-steps.jsonl";
  if (
    trajectoryFilename.length === 0
    || basename(trajectoryFilename) !== trajectoryFilename
  ) {
    throw new Error("trajectoryFilename must be a nonempty filename without directories");
  }
  const runRoots = [resolve(auditRoot, "gold"), resolve(auditRoot, "visuals/runs")];
  const trajectoryPaths = runRoots.flatMap((root) => findNamedFiles(root, trajectoryFilename));
  if (trajectoryPaths.length === 0) {
    throw new Error(
      `No '${trajectoryFilename}' engine-step evidence found under ${auditRoot}.`,
    );
  }

  const groups = new Map<string, ViewerScenarioGroup>();
  let stepCount = 0;
  for (const trajectoryPath of trajectoryPaths) {
    const runDirectory = dirname(trajectoryPath);
    const manifestPath = resolve(runDirectory, "audit-manifest.json");
    if (!existsSync(manifestPath)) throw new Error(`Missing audit manifest beside ${trajectoryPath}`);
    const manifest = parseAuditManifest(JSON.parse(readFileSync(manifestPath, "utf8")) as unknown);
    const scenarioPath = resolveScenarioPath(auditRoot, manifest);
    const scenarioSource = readFileSync(scenarioPath, "utf8");
    const scenarioSha256 = createHash("sha256").update(scenarioSource, "utf8").digest("hex");
    if (scenarioSha256 !== manifest.scenarioSha256) {
      throw new Error(`Scenario hash mismatch for ${scenarioPath}`);
    }
    const scenario = parseExperimentScenario(JSON.parse(scenarioSource) as unknown);
    if (scenario.family === "pairwise" && scenario.variant === "overtaking") continue;
    if (scenario.name !== manifest.scenarioName) {
      throw new Error(`Scenario name mismatch in ${manifestPath}`);
    }

    const steps: EngineStepRecord[] = [];
    forEachJsonLineSync(trajectoryPath, (line) => {
      steps.push(validateEngineStepRecord(JSON.parse(line) as EngineStepRecord));
    });
    if (steps.length === 0) throw new Error(`Trajectory has no completed steps: ${trajectoryPath}`);
    const frameDurationsSeconds = computeStoredFrameDurations(steps);
    stepCount += steps.length;

    const groupKey = `${manifest.scenarioName}--${manifest.scenarioSha256}`;
    const existingGroup = groups.get(groupKey);
    const group: ViewerScenarioGroup = existingGroup ?? {
      key: groupKey,
      scenarioSha256: manifest.scenarioSha256,
      scenario,
      runs: [],
    };
    group.runs.push({
      methodId: manifest.methodId,
      methodLabel: METHOD_LABELS[manifest.methodId] ?? manifest.methodId,
      methodKey: manifest.methodKey,
      engineId: manifest.engineId,
      correctionMode: manifest.correctionMode,
      commandVelocityMeaning: manifest.commandVelocityMeaning,
      source: {
        manifest: displayPath(manifestPath),
        trajectory: displayPath(trajectoryPath),
        scenario: displayPath(scenarioPath),
      },
      closestPreCorrectionEncounter: computeClosestPreCorrectionEncounter(scenario, steps),
      avoidanceOnsets: computeFirstAvoidanceOnsets(scenario, steps),
      frameDurationsSeconds,
      steps: steps.map((step) => ({
        stepIndex: step.stepIndex,
        time: step.time,
        agents: step.agents.map((agent) => ({
          id: agent.id,
          preCorrectionPosition: agent.preCorrectionPosition,
          postCorrectionPosition: agent.postCorrectionPosition,
          arrived: agent.arrived,
        })),
      })),
    });
    groups.set(groupKey, group);
  }

  const scenarioGroups = [...groups.values()]
    .sort((first, second) => first.scenario.name.localeCompare(second.scenario.name))
    .map((group) => ({
      ...group,
      runs: group.runs.sort((first, second) =>
        (METHOD_ORDER[first.methodId] ?? Number.MAX_SAFE_INTEGER)
          - (METHOD_ORDER[second.methodId] ?? Number.MAX_SAFE_INTEGER)
          || first.methodId.localeCompare(second.methodId)),
    }));

  mkdirSync(outputDirectory, { recursive: true });
  const staticDirectory = dirname(fileURLToPath(import.meta.url));
  for (const name of ["index.html", "viewer.css", "viewer.js"] as const) {
    copyFileSync(resolve(staticDirectory, name), resolve(outputDirectory, name));
  }
  const reviewData = {
    reviewDataVersion: 1,
    status: "PENDING HUMAN REVIEW",
    notice: "This viewer is local inspection support only and does not record human approval.",
    scenarios: scenarioGroups,
  };
  writeFileSync(
    resolve(outputDirectory, "review-data.js"),
    `globalThis.LEAN_REVIEW_DATA = ${JSON.stringify(reviewData)};\n`,
    "utf8",
  );
  const indexPath = resolve(outputDirectory, "index.html");
  return {
    indexPath,
    scenarioCount: scenarioGroups.length,
    runCount: trajectoryPaths.length,
    stepCount,
  };
}

function parseAuditManifest(value: unknown): AuditManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("audit-manifest.json must contain an object");
  }
  const root = value as Record<string, unknown>;
  const required = [
    "scenarioPath",
    "scenarioSha256",
    "scenarioName",
    "methodId",
    "methodKey",
    "engineId",
    "correctionMode",
    "commandVelocityMeaning",
  ] as const;
  for (const key of required) {
    if (typeof root[key] !== "string" || root[key].length === 0) {
      throw new Error(`audit-manifest.${key} must be a nonempty string`);
    }
  }
  return root as unknown as AuditManifest;
}

function resolveScenarioPath(auditRoot: string, manifest: AuditManifest): string {
  if (existsSync(manifest.scenarioPath)) return resolve(manifest.scenarioPath);
  const candidates = [
    resolve(auditRoot, "visuals/scenarios", `${manifest.scenarioName}.json`),
    ...findJsonFiles(resolve("experiments/audit/scenarios")),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const scenario = parseExperimentScenario(JSON.parse(readFileSync(candidate, "utf8")) as unknown);
      if (scenario.name === manifest.scenarioName) return candidate;
    } catch {
      // A different JSON input is not a matching experiment scenario.
    }
  }
  throw new Error(`Cannot locate scenario '${manifest.scenarioName}' referenced by the audit manifest`);
}

function findNamedFiles(directory: string, name: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return findNamedFiles(path, name);
    return entry.name === name ? [path] : [];
  }).sort();
}

function findJsonFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return findJsonFiles(path);
    return entry.name.endsWith(".json") ? [path] : [];
  }).sort();
}

function displayPath(path: string): string {
  const repositoryRelative = relative(resolve("."), path);
  return repositoryRelative.startsWith("..") ? basename(path) : repositoryRelative.replaceAll("\\", "/");
}

function distance(first: Vec2, second: Vec2): number {
  return Math.hypot(first[0] - second[0], first[1] - second[1]);
}

function magnitude(vector: Vec2): number {
  return Math.hypot(vector[0], vector[1]);
}

function dot(first: Vec2, second: Vec2): number {
  return first[0] * second[0] + first[1] * second[1];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function parseOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a path`);
  return value;
}

function main(): void {
  try {
    const result = generateReviewIndex({
      auditRoot: parseOption("--audit-root"),
      outputDirectory: parseOption("--out"),
      trajectoryFilename: parseOption("--trajectory-file"),
    });
    console.log(
      `audit:viewer indexed ${result.runCount} runs across ${result.scenarioCount} scenarios (${result.stepCount} steps).`,
    );
    console.log(`Open ${pathToFileURL(result.indexPath).href}`);
    console.log("Status remains PENDING HUMAN REVIEW; no readiness artifact was changed.");
  } catch (error) {
    console.error(`audit:viewer failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) main();
