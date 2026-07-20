import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { generateReviewIndex } from "../audit/viewer/generateReviewIndex";
import type { EngineStepRecord } from "../engines/engineStep";
import { generateExperimentScenario } from "../generation/generateScenario";
import type { RunMetrics } from "../metrics/types";
import { completionRuleForAgent, detectCompletion } from "../protocol/completion";
import { forEachJsonLineSync } from "../protocol/jsonLines";
import { identifyMethod } from "../protocol/methodIdentity";
import { parseMethodConfig } from "../protocol/methodConfig";
import { packageViewerTrajectories } from "./worker";
import { loadStudy, runPool, runKey, type Assignment } from "./run";

const OUTPUT_ROOT = "results/protocol-audit/completion-v2-current";
const SCENARIOS = ["head-on", "crossing", "circle", "corridor", "bottleneck"] as const;
const SEED = 400;

interface AuditRow {
  key: string;
  scenarioType: string;
  method: string;
  artifactDirectory: string;
  successFraction: number;
  legacyPointGoalSuccessFraction: number;
  normalizedCompletionTime: number | null;
  minimumPointGoalDistance: number;
  finalPointGoalDistance: number | null;
  correctionEjectedGoalDiskEntries: number;
}

async function main(): Promise<void> {
  const study = loadStudy();
  const assignments: Assignment[] = SCENARIOS.flatMap((scenarioType) => {
    const scenario = study.scenarios[scenarioType];
    if (scenario === undefined) throw new Error(`Missing completion-audit scenario ${scenarioType}`);
    return Object.entries(study.methods).map(([method, methodConfig]) => ({
      phase: "completion-audit",
      scenarioType,
      seed: SEED,
      method,
      scenario,
      methodConfig,
      outputRoot: OUTPUT_ROOT,
      visual: true,
    }));
  });
  const pending = assignments.filter((assignment) => !hasCompletedArtifact(assignment));
  console.log(`completion audit: ${pending.length} pending, ${assignments.length - pending.length} resumed`);
  const freshRecords = await runPool(pending, 4, (record) => {
    console.log(`${record.status} ${record.scenarioType} ${record.method}`);
  });
  const failure = freshRecords.find(({ status }) => status !== "PASS");
  if (failure !== undefined) {
    throw new Error(`Completion audit failed for ${failure.scenarioType}/${failure.method}: ${String(failure.error)}`);
  }
  const records = assignments.map(loadAuditRow);
  const root = resolve(OUTPUT_ROOT);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    resolve(root, "audit-records.jsonl"),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
  const packaged = packageViewerTrajectories(resolve(root, "audit"));
  const viewer = generateReviewIndex({
    auditRoot: resolve(root, "audit"),
    outputDirectory: resolve(root, "viewer"),
  });
  verifyAuditStructure(assignments, records);
  printTable(records);
  console.log(`packaged ${packaged.runCount} trajectories`);
  console.log(`viewer ${pathToFileURL(viewer.indexPath).href}`);
}

function artifactDirectory(assignment: Assignment): string {
  const scenario = generateExperimentScenario({ ...assignment.scenario, split: "lean", seed: assignment.seed });
  const methodSource = `${JSON.stringify(assignment.methodConfig, null, 2)}\n`;
  const method = parseMethodConfig(JSON.parse(methodSource) as unknown);
  const identity = identifyMethod(method, methodSource);
  return resolve(OUTPUT_ROOT, "audit", "visuals", "runs", scenario.name, identity.methodKey);
}

function hasCompletedArtifact(assignment: Assignment): boolean {
  const directory = artifactDirectory(assignment);
  return existsSync(resolve(directory, "audit-manifest.json"))
    && existsSync(resolve(directory, "run-metrics.json"))
    && (existsSync(resolve(directory, "engine-steps.jsonl"))
      || existsSync(resolve(directory, "engine-steps-full.jsonl")));
}

function loadAuditRow(assignment: Assignment): AuditRow {
  const directory = artifactDirectory(assignment);
  if (!hasCompletedArtifact(assignment)) {
    throw new Error(`Missing completed audit artifact for ${runKey(assignment)}`);
  }
  const metrics = JSON.parse(readFileSync(resolve(directory, "run-metrics.json"), "utf8")) as RunMetrics;
  const outcomes = metrics.completion.perAgent;
  return {
    key: runKey(assignment),
    scenarioType: assignment.scenarioType,
    method: assignment.method,
    artifactDirectory: directory,
    successFraction: metrics.completion.successFraction,
    legacyPointGoalSuccessFraction: metrics.completion.legacyPointGoalSuccessFraction,
    normalizedCompletionTime: metrics.completionTime.medianNormalizedCompletionTime,
    minimumPointGoalDistance: Math.min(...outcomes.map(({ minimumDistanceToPointGoal }) => minimumDistanceToPointGoal)),
    finalPointGoalDistance: median(outcomes.map(({ finalDistanceToPointGoal }) => finalDistanceToPointGoal)),
    correctionEjectedGoalDiskEntries: metrics.completion.correctionEjectedGoalDiskEntries,
  };
}

function verifyAuditStructure(assignments: readonly Assignment[], records: readonly AuditRow[]): void {
  if (records.length !== SCENARIOS.length * 4) throw new Error("Completion audit must contain 20 runs");
  for (const scenario of ["head-on", "crossing"] as const) {
    const scenarioPath = records.find((record) => record.scenarioType === scenario)?.artifactDirectory;
    if (typeof scenarioPath !== "string") throw new Error(`Missing ${scenario} audit artifact`);
    const manifest = JSON.parse(readFileSync(resolve(scenarioPath, "audit-manifest.json"), "utf8")) as {
      expectedStepCount: number;
    };
    if (manifest.expectedStepCount !== 1800) throw new Error(`${scenario} does not use a 30-second horizon`);
  }
  if (records.some((record) => record.artifactDirectory === null)) {
    throw new Error("Completion audit is missing a trajectory artifact");
  }
  for (const assignment of assignments.filter(({ scenarioType }) =>
    scenarioType === "corridor" || scenarioType === "bottleneck")) {
    verifyLineCompletionTrajectory(assignment);
  }
}

function verifyLineCompletionTrajectory(assignment: Assignment): void {
  const directory = artifactDirectory(assignment);
  const scenario = generateExperimentScenario({ ...assignment.scenario, split: "lean", seed: assignment.seed });
  const metrics = JSON.parse(readFileSync(resolve(directory, "run-metrics.json"), "utf8")) as RunMetrics;
  const expected = new Set(metrics.completion.perAgent
    .filter(({ firstCompletionTime }) => firstCompletionTime !== null)
    .map(({ id }) => id));
  if (expected.size === 0) {
    throw new Error(`${assignment.scenarioType}/${assignment.method} has no line completions to audit`);
  }
  const agents = new Map(scenario.agents.map((agent) => [agent.id, agent]));
  const crossed = new Map<number, { stepIndex: number; endpointProgress: number }>();
  const continued = new Set<number>();
  const trajectory = existsSync(resolve(directory, "engine-steps-full.jsonl"))
    ? resolve(directory, "engine-steps-full.jsonl")
    : resolve(directory, "engine-steps.jsonl");
  forEachJsonLineSync(trajectory, (line) => {
    const step = JSON.parse(line) as EngineStepRecord;
    for (const state of step.agents) {
      const agent = agents.get(state.id);
      if (agent === undefined) throw new Error(`Unknown trajectory agent ${state.id}`);
      const rule = completionRuleForAgent(scenario, state.id);
      if (rule.type !== "directional_line") {
        throw new Error(`${assignment.scenarioType} does not use directional-line completion`);
      }
      const axis = rule.axis === "x" ? 0 : 1;
      const sign = rule.direction === "positive" ? 1 : -1;
      const existing = crossed.get(state.id);
      if (existing === undefined) {
        if (detectCompletion(scenario, agent, state.positionBefore, state.postCorrectionPosition) !== null) {
          crossed.set(state.id, {
            stepIndex: step.stepIndex,
            endpointProgress: sign * state.postCorrectionPosition[axis],
          });
        }
      } else if (step.stepIndex > existing.stepIndex
        && sign * state.postCorrectionPosition[axis] > existing.endpointProgress + 1e-6) {
        continued.add(state.id);
      }
    }
  });
  const observed = new Set(crossed.keys());
  if (expected.size !== observed.size || [...expected].some((id) => !observed.has(id))) {
    throw new Error(`${assignment.scenarioType}/${assignment.method} metric and trajectory completions disagree`);
  }
  if ([...expected].some((id) => !continued.has(id))) {
    throw new Error(`${assignment.scenarioType}/${assignment.method} has a completed agent that did not continue beyond the line`);
  }
  console.log(`trajectory check ${assignment.scenarioType}/${assignment.method}: ${expected.size} crossed and continued`);
}

function printTable(records: readonly AuditRow[]): void {
  console.log([
    "scenario",
    "method",
    "completion",
    "legacy-goal",
    "median-normalized-completion",
    "minimum-point-goal-distance",
    "median-final-point-goal-distance",
    "correction-ejected-goal-entries",
  ].join("\t"));
  for (const record of records) {
    console.log([
      record.scenarioType,
      record.method,
      number(record.successFraction),
      number(record.legacyPointGoalSuccessFraction),
      number(record.normalizedCompletionTime),
      number(record.minimumPointGoalDistance),
      number(record.finalPointGoalDistance),
      number(record.correctionEjectedGoalDiskEntries),
    ].join("\t"));
  }
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((first, second) => first - second);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

function number(value: unknown): string {
  return typeof value === "number" ? value.toFixed(6) : "null";
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  main().catch((error) => {
    console.error(`protocol:audit failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
