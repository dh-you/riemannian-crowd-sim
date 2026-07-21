import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { generateReviewIndex } from "../../audit/viewer/generateReviewIndex";
import { generateExperimentScenario } from "../../generation/generateScenario";
import { detectCompletion, resolveProtocolTarget } from "../../protocol/completion";
import { forEachJsonLineSync } from "../../protocol/jsonLines";
import { serializeExperimentScenario, type ExperimentScenario } from "../../protocol/schema";
import { validateEngineStepRecord, type EngineStepRecord } from "../../engines/engineStep";
import { runAuditedEngine } from "../../lean/audit/auditRun";
import { containsNonFinite, writeJson } from "../../lean/audit/runUtils";
import { packageViewerTrajectories } from "../../lean/worker";
import type { RunMetrics } from "../../metrics/types";

const DEFAULT_ROOT = resolve("results/jupedsim-integration/audit-v2");
const METHOD_PATH = resolve("experiments/methods/jupedsim-sfm-default.json");
const SEED = 400;

const SCENARIOS = [
  { key: "head-on", family: "pairwise", variant: "head_on" },
  { key: "crossing", family: "pairwise", variant: "crossing" },
  { key: "circle", family: "circle_antipodal", variant: "perturbed", agentCount: 50 },
  { key: "corridor", family: "bidirectional", variant: "corridor", agentCount: 120 },
  { key: "bottleneck", family: "bottleneck", variant: "central_opening", agentCount: 112 },
] as const;

interface AuditTableRow {
  scenario: string;
  status: "PASS";
  completionFraction: number;
  normalizedCompletionTime: number | null;
  maximumPenetration: number;
  overlapExposure: number | null;
  rmsAcceleration: number | null;
  minimumClearance: number | null;
  finalPointGoalDistance: number;
  runtimeSeconds: number;
  artifactDirectory: string;
}

export function runJuPedSimAudit(outputRoot = DEFAULT_ROOT): {
  root: string;
  viewerPath: string;
  rows: AuditTableRow[];
} {
  const root = resolve(outputRoot);
  if (existsSync(root) && readdirSync(root).length > 0) {
    throw new Error("Refusing to overwrite nonempty JuPedSim audit root: " + root);
  }
  mkdirSync(root, { recursive: true });
  const scenarioDirectory = resolve(root, "visuals", "scenarios");
  const runRoot = resolve(root, "visuals", "runs");
  mkdirSync(scenarioDirectory, { recursive: true });
  mkdirSync(runRoot, { recursive: true });
  const rows: AuditTableRow[] = [];
  for (const spec of SCENARIOS) {
    const scenario = generateExperimentScenario({
      family: spec.family,
      variant: spec.variant,
      split: "jupedsim_integration",
      seed: SEED,
      ...("agentCount" in spec ? { agentCount: spec.agentCount } : {}),
    });
    const scenarioPath = resolve(scenarioDirectory, scenario.name + ".json");
    writeFileSync(scenarioPath, serializeExperimentScenario(scenario), "utf8");
    const outputDirectory = resolve(runRoot, scenario.name, "jupedsim-sfm");
    const started = performance.now();
    const artifacts = runAuditedEngine(scenarioPath, METHOD_PATH, outputDirectory);
    const runtimeSeconds = (performance.now() - started) / 1000;
    const metrics = JSON.parse(readFileSync(artifacts.metricsPath, "utf8")) as RunMetrics;
    validateFullTrajectory(scenario, artifacts.trajectoryPath, metrics);
    rows.push({
      scenario: spec.key,
      status: "PASS",
      completionFraction: metrics.completion.successFraction,
      normalizedCompletionTime: metrics.completionTime.medianNormalizedCompletionTime,
      maximumPenetration: Math.max(
        metrics.separation.maximumPreCorrectionAgentPenetration,
        metrics.separation.maximumPreCorrectionWallPenetration,
      ),
      overlapExposure: metrics.separation.preCorrectionOverlapPairSecondsPerAgentSecond,
      rmsAcceleration: metrics.smoothness.rmsAcceleration,
      minimumClearance: minimumNullable(
        metrics.separation.minimumPreCorrectionAgentClearance,
        metrics.separation.minimumPreCorrectionWallClearance,
      ),
      finalPointGoalDistance: median(
        metrics.completion.perAgent.map((entry) => entry.finalDistanceToPointGoal),
      ),
      runtimeSeconds,
      artifactDirectory: artifacts.outputDirectory,
    });
  }
  if (rows.length !== 5) throw new Error("JuPedSim audit did not produce exactly five assignments");
  const packaged = packageViewerTrajectories(root);
  if (packaged.runCount !== 5) throw new Error("JuPedSim viewer packaging did not preserve five runs");
  const viewer = generateReviewIndex({
    auditRoot: root,
    outputDirectory: resolve(root, "viewer"),
  });
  if (viewer.runCount !== 5 || viewer.scenarioCount !== 5) {
    throw new Error("JuPedSim viewer did not index five runs across five scenarios");
  }
  writeJson(resolve(root, "audit-summary.json"), {
    auditVersion: 1,
    methodKey: "jupedsim-sfm",
    seed: SEED,
    assignments: 5,
    pass: 5,
    fail: 0,
    fullTrajectoriesPreserved: true,
    viewerPath: viewer.indexPath,
    rows,
  });
  const table = tableText(rows);
  writeFileSync(resolve(root, "five-run-table.tsv"), table, "utf8");
  process.stdout.write(table);
  console.log("audit: 5 PASS, 0 FAIL");
  console.log("viewer: " + viewer.indexPath);
  return { root, viewerPath: viewer.indexPath, rows };
}

function validateFullTrajectory(
  scenario: ExperimentScenario,
  trajectoryPath: string,
  metrics: RunMetrics,
): void {
  const expectedSteps = Math.round(
    scenario.simulation.horizonSeconds / scenario.simulation.dt,
  );
  const expectedIds = scenario.agents.map((agent) => agent.id);
  const definitions = new Map(scenario.agents.map((agent) => [agent.id, agent]));
  const completed = new Set<number>();
  const continuedAfterCompletion = new Set<number>();
  const completionSteps = new Map<number, number>();
  const priorCompletionProgress = new Map<number, number>();
  let observedSteps = 0;
  forEachJsonLineSync(trajectoryPath, (line, index) => {
    const record = validateEngineStepRecord(JSON.parse(line) as EngineStepRecord);
    if (record.stepIndex !== index) throw new Error("Audit trajectory step order mismatch");
    if (record.agents.map((agent) => agent.id).join(",") !== expectedIds.join(",")) {
      throw new Error("Audit trajectory agent IDs are unstable");
    }
    if (record.diagnostics.correctionMode !== "native_none" || containsNonFinite(record)) {
      throw new Error("Audit trajectory is nonfinite or uses a non-native correction");
    }
    for (const state of record.agents) {
      const definition = definitions.get(state.id);
      if (definition === undefined) throw new Error("Audit trajectory contains an unknown agent");
      const target = resolveProtocolTarget(scenario, {
        ...definition,
        position: state.positionBefore,
      });
      if (!vectorsMatch(state.navigationTarget, target)) {
        throw new Error("Audit trajectory target sequence differs from completion-v2");
      }
      if (!completed.has(state.id)) {
        if (
          detectCompletion(
            scenario,
            definition,
            state.positionBefore,
            state.postCorrectionPosition,
          ) !== null
        ) {
          completed.add(state.id);
          completionSteps.set(state.id, index);
          priorCompletionProgress.set(state.id, progressAfterCompletion(scenario, state));
        }
      } else if ((completionSteps.get(state.id) ?? index) < index) {
        const previous = priorCompletionProgress.get(state.id) ?? Number.NEGATIVE_INFINITY;
        const current = progressAfterCompletion(scenario, state);
        if (current > previous + 1e-6) continuedAfterCompletion.add(state.id);
        priorCompletionProgress.set(state.id, Math.max(previous, current));
      }
      validateScenarioContainment(scenario, state);
    }
    observedSteps += 1;
  });
  if (observedSteps !== expectedSteps) {
    throw new Error("Audit trajectory step count mismatch");
  }
  if (
    completed.size !== metrics.completion.completedAgents
    || metrics.completion.successFraction !== completed.size / scenario.agents.length
  ) {
    throw new Error("Completion-v2 reconstruction differs from run metrics");
  }
  if (
    scenario.completion.rule.type !== "goal_disk"
    && [...completed].some((id) => !continuedAfterCompletion.has(id))
  ) {
    throw new Error("A directionally completed agent did not remain and continue");
  }
  const requiredMetrics = [
    metrics.separation.maximumPreCorrectionAgentPenetration,
    metrics.separation.maximumPreCorrectionWallPenetration,
    metrics.separation.preCorrectionOverlapPairSecondsPerAgentSecond,
    metrics.smoothness.rmsAcceleration,
    metrics.separation.minimumPreCorrectionAgentClearance,
  ];
  if (requiredMetrics.some((value) => value !== null && !Number.isFinite(value))) {
    throw new Error("Audit metrics contain a nonfinite required value");
  }
}

function validateScenarioContainment(
  scenario: ExperimentScenario,
  state: EngineStepRecord["agents"][number],
): void {
  if (scenario.family === "bidirectional" && scenario.variant === "corridor") {
    const wallY = scenario.walls.flatMap((wall) => [wall.start[1], wall.end[1]]);
    if (
      state.postCorrectionPosition[1] <= Math.min(...wallY)
      || state.postCorrectionPosition[1] >= Math.max(...wallY)
    ) {
      throw new Error("Corridor agent crossed a wall");
    }
  }
  if (scenario.family !== "bottleneck") return;
  const position = state.postCorrectionPosition;
  if (position[0] <= -14 || position[0] >= 12 || position[1] <= -6 || position[1] >= 6) {
    throw new Error("Bottleneck agent bypassed the closed chamber exterior");
  }
  if (state.positionBefore[0] <= 0 && position[0] > 0) {
    const fraction = -state.positionBefore[0] / (position[0] - state.positionBefore[0]);
    const crossingY = state.positionBefore[1]
      + fraction * (position[1] - state.positionBefore[1]);
    if (Math.abs(crossingY) >= 1.2) {
      throw new Error("Bottleneck divider crossing occurred outside the central opening");
    }
  }
}

function progressAfterCompletion(
  scenario: ExperimentScenario,
  state: EngineStepRecord["agents"][number],
): number {
  const rule = scenario.completion.rule;
  if (rule.type === "directional_line") {
    const coordinate = state.postCorrectionPosition[rule.axis === "x" ? 0 : 1];
    return rule.direction === "positive" ? coordinate : -coordinate;
  }
  if (rule.type === "per_agent_directional_line") {
    const selected = rule.rules.find((entry) => entry.agentId === state.id);
    if (selected === undefined) throw new Error("Missing per-agent completion rule");
    const coordinate = state.postCorrectionPosition[selected.axis === "x" ? 0 : 1];
    return selected.direction === "positive" ? coordinate : -coordinate;
  }
  return 0;
}

function vectorsMatch(first: readonly number[], second: readonly number[]): boolean {
  return first.length === 2 && second.length === 2
    && Math.abs(first[0] - second[0]) <= 1e-12
    && Math.abs(first[1] - second[1]) <= 1e-12;
}

function minimumNullable(...values: Array<number | null>): number | null {
  const finite = values.filter((value): value is number => value !== null);
  return finite.length === 0 ? null : Math.min(...finite);
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((first, second) => first - second);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

function tableText(rows: readonly AuditTableRow[]): string {
  const lines = [[
    "scenario",
    "status",
    "completion_fraction",
    "normalized_completion_time",
    "maximum_penetration",
    "overlap_exposure",
    "rms_acceleration",
    "minimum_clearance",
    "final_point_goal_distance",
    "runtime_seconds",
  ].join("\t")];
  for (const row of rows) {
    lines.push([
      row.scenario,
      row.status,
      format(row.completionFraction),
      format(row.normalizedCompletionTime),
      format(row.maximumPenetration),
      format(row.overlapExposure),
      format(row.rmsAcceleration),
      format(row.minimumClearance),
      format(row.finalPointGoalDistance),
      format(row.runtimeSeconds),
    ].join("\t"));
  }
  return lines.join("\n") + "\n";
}

function format(value: number | null): string {
  return value === null ? "null" : value.toFixed(8);
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  try {
    runJuPedSimAudit();
  } catch (error) {
    console.error("jupedsim:audit failed: " + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}
