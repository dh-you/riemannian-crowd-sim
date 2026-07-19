import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runAuditedEngine } from "../audit/cli/auditRun";
import { runExperiment } from "../cli/runExperiment";
import { generateExperimentScenario } from "../generation/generateScenario";
import { RunMetricsAccumulator } from "../metrics/RunMetricsAccumulator";
import type { RunMetrics } from "../metrics/types";
import { identifyMethod } from "../protocol/methodIdentity";
import { parseMethodConfig } from "../protocol/methodConfig";
import { serializeExperimentScenario } from "../protocol/schema";
import { runRiemannianAblation } from "../studies/stage-d/ablations/RiemannianAblationEngine";
import { identifyRiemannianAblationConfig, parseRiemannianAblationConfig } from "../studies/stage-d/ablations/config";
import { assignmentIdentity, runKey, validateWorkerRecord, type Assignment, type RunRecord } from "./run";

const METRIC_FIELDS = {
  successFraction: null, normalizedTravelTime: null, pathRatio: null,
  preCorrectionOverlapExposure: null, maximumPhysicalPenetration: null,
  minimumPhysicalClearance: null, rmsAcceleration: null, correctionRatio: null,
  throughput: null, pairwiseAvoidanceOnsetRate: null,
} as const;

export function executeAssignment(assignment: Assignment): RunRecord {
  const started = performance.now(); let failure: unknown; let record: RunRecord | undefined;
  const root = resolve(assignment.outputRoot); const work = resolve(root, "work", runKey(assignment).replaceAll("/", "--"));
  if (!work.startsWith(`${root}\\`) && !work.startsWith(`${root}/`)) throw new Error("Lean work path escaped output root");
  rmSync(work, { recursive: true, force: true }); mkdirSync(work, { recursive: true });
  try {
    const scenario = generateExperimentScenario({ ...assignment.scenario, split: "lean", seed: assignment.seed });
    const scenarioSource = serializeExperimentScenario(scenario); const scenarioPath = resolve(work, "scenario.json");
    writeFileSync(scenarioPath, scenarioSource, "utf8");
    let metrics: RunMetrics; let artifactDirectory: string | null = null;
    if (assignment.ablation !== undefined) {
      const configSource = `${JSON.stringify(assignment.methodConfig, null, 2)}\n`;
      const config = parseRiemannianAblationConfig(JSON.parse(configSource) as unknown);
      const identity = identifyRiemannianAblationConfig(config, configSource);
      const methodParameters = { ...config.parameters, closingGate: config.gates.closing ? 1 : 0, visibilityGate: config.gates.visibility ? 1 : 0 };
      const accumulator = new RunMetricsAccumulator(scenario, {
        ...identity, methodConfigSha256: identity.methodConfigCanonicalSha256,
        velocityTimeConstant: config.velocityTimeConstant, methodParameters,
        engineId: "scientific_core_ablation_engine_v1", engineAdapterVersion: "1",
        correctionMode: scenario.simulation.correction.enabled ? "shared_projection" : "disabled",
        commandVelocityMeaning: "ablation controller target velocity before Scientific Core smoothing",
        upstreamProject: null, upstreamCommit: null, upstreamLicense: null,
      });
      const result = runRiemannianAblation(scenario, config, (step) => accumulator.observeStep(step));
      metrics = accumulator.finish(result.finalStates);
    } else {
      const methodSource = `${JSON.stringify(assignment.methodConfig, null, 2)}\n`;
      const method = parseMethodConfig(JSON.parse(methodSource) as unknown); const identity = identifyMethod(method, methodSource);
      const methodPath = resolve(work, "method.json"); writeFileSync(methodPath, methodSource, "utf8");
      if (assignment.visual) {
        const scenarioDirectory = resolve(root, "audit", "visuals", "scenarios"); mkdirSync(scenarioDirectory, { recursive: true });
        const runDirectory = resolve(root, "audit", "visuals", "runs", scenario.name, identity.methodKey);
        const result = runAuditedEngine(scenarioPath, methodPath, runDirectory);
        metrics = JSON.parse(readFileSync(result.metricsPath, "utf8")) as RunMetrics;
        writeFileSync(resolve(scenarioDirectory, `${scenario.name}.json`), scenarioSource, "utf8");
        artifactDirectory = runDirectory;
      } else {
        const result = runExperiment({ scenarioPath, methodPath, outputDirectory: resolve(work, "out"),
          recordingInterval: Math.round(scenario.simulation.horizonSeconds / scenario.simulation.dt) });
        metrics = result.metrics;
      }
    }
    record = metricRecord(assignment, metrics, scenario.agents.length, artifactDirectory, (performance.now() - started) / 1000);
  } catch (error) { failure = error; }
  finally { rmSync(work, { recursive: true, force: true }); }
  if (record !== undefined) return validateWorkerRecord(record);
  return validateWorkerRecord(failureRecord(assignment, failure, (performance.now() - started) / 1000));
}

function metricRecord(assignment: Assignment, metrics: RunMetrics, agentCount: number, artifactDirectory: string | null, runtimeSeconds: number): RunRecord {
  const pairwise = metrics.pairwise?.perAgent ?? [];
  return {
    key: runKey(assignment), assignmentIdentity: assignmentIdentity(assignment), phase: assignment.phase,
    scenarioType: assignment.scenarioType, seed: assignment.seed, method: assignment.method,
    ablation: assignment.ablation ?? null, repetition: assignment.repetition ?? null, warmup: assignment.warmup ?? null,
    agentCount, status: "PASS", error: null,
    successFraction: metrics.completion.successFraction,
    normalizedTravelTime: metrics.travelTime.meanNormalizedTravelTime,
    pathRatio: metrics.pathEfficiency.meanPathEfficiency,
    preCorrectionOverlapExposure: metrics.separation.preCorrectionOverlapPairSecondsPerAgentSecond,
    maximumPhysicalPenetration: metrics.separation.maximumPreCorrectionAgentPenetration,
    minimumPhysicalClearance: metrics.separation.minimumPreCorrectionAgentClearance,
    rmsAcceleration: metrics.smoothness.rmsAcceleration,
    correctionRatio: metrics.identity.correctionMode === "native_none" ? null : metrics.correctionDependence.correctionRatio,
    throughput: assignment.scenario.family === "bottleneck" || assignment.phase === "runtime" ? metrics.throughput : null,
    pairwiseAvoidanceOnsetRate: metrics.pairwise === null ? null : pairwise.filter((entry) => entry.avoidanceOnsetTime !== null).length / pairwise.length,
    methodParameters: metrics.identity.methodParameters, engineId: metrics.identity.engineId,
    correctionMode: metrics.identity.correctionMode, commandVelocityMeaning: metrics.identity.commandVelocityMeaning,
    artifactDirectory, runtimeSeconds,
  };
}

function failureRecord(assignment: Assignment, error: unknown, runtimeSeconds: number): RunRecord {
  const parameters = (assignment.methodConfig as { parameters?: unknown })?.parameters ?? {};
  return {
    key: runKey(assignment), assignmentIdentity: assignmentIdentity(assignment), phase: assignment.phase,
    scenarioType: assignment.scenarioType, seed: assignment.seed, method: assignment.method,
    ablation: assignment.ablation ?? null, repetition: assignment.repetition ?? null, warmup: assignment.warmup ?? null,
    agentCount: assignment.scenario.agentCount ?? null, status: "FAIL",
    error: error instanceof Error ? error.message : String(error), ...METRIC_FIELDS,
    methodParameters: parameters, engineId: null, correctionMode: null,
    commandVelocityMeaning: null, artifactDirectory: null, runtimeSeconds,
  };
}

function main(): void {
  let record: RunRecord;
  try {
    const source = process.argv[2]; if (source === undefined) throw new Error("Worker requires one assignment JSON argument");
    record = executeAssignment(JSON.parse(source) as Assignment);
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1; return;
  }
  if (record.status === "FAIL") { console.error(record.error); process.exitCode = 1; }
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) main();
