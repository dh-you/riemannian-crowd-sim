import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { EngineStepRecord } from "../../engines/engineStep";
import { validateEngineStepRecord } from "../../engines/engineStep";
import { RunMetricsAccumulator } from "../../metrics/RunMetricsAccumulator";
import { forEachJsonLineSync } from "../../protocol/jsonLines";
import { parseExperimentScenario } from "../../protocol/schema";
import { AUDIT_RESULTS_ROOT, runPython, writeJson } from "./auditUtils";
import { finalStatesFromRecords, runAuditedEngine } from "./auditRun";

const METHOD_PATHS = [
  "experiments/methods/riemannian-default.json",
  "experiments/methods/goal-projection.json",
  "experiments/methods/orca-default.json",
  "experiments/methods/social-force-default.json",
] as const;

interface ComparisonSummary {
  status: "PASS" | "FAIL";
  metricCount: number;
  maximumAbsoluteDifference: number;
  firstFailure: unknown;
}

export interface MetricAuditResult {
  status: "PASS";
  comparisons: number;
  realMethodComparisons: number;
  maximumAbsoluteDifference: number;
  reportPath: string;
}

function compareIndependent(
  scenarioPath: string,
  trajectoryPath: string,
  pipelinePath: string,
  outputRoot: string,
): ComparisonSummary {
  const independentPath = resolve(outputRoot, "independent-metrics.json");
  const comparisonPath = resolve(outputRoot, "comparison.json");
  runPython("experiments/audit/python/evaluate_metrics.py", ["--scenario", resolve(scenarioPath), "--trajectory", trajectoryPath, "--out", independentPath]);
  runPython("experiments/audit/python/compare_metrics.py", ["--pipeline", pipelinePath, "--independent", independentPath, "--report", comparisonPath]);
  return JSON.parse(readFileSync(comparisonPath, "utf8")) as ComparisonSummary;
}

function syntheticPipelineMetrics(scenarioPath: string, trajectoryPath: string, outputPath: string): void {
  const scenario = parseExperimentScenario(JSON.parse(readFileSync(scenarioPath, "utf8")) as unknown);
  const records: EngineStepRecord[] = [];
  const accumulator = new RunMetricsAccumulator(scenario, {
    methodId: "independent_synthetic_fixture",
    methodKey: "independent_synthetic_fixture--000000000000",
    methodConfigSha256: "0".repeat(64),
    velocityTimeConstant: null,
    methodParameters: {},
  });
  forEachJsonLineSync(trajectoryPath, (line) => {
    const record = validateEngineStepRecord(JSON.parse(line) as EngineStepRecord);
    records.push(record);
    accumulator.observeStep(record);
  });
  const last = records.at(-1);
  const finalStates = finalStatesFromRecords(scenario.agents, last?.agents ?? []);
  writeJson(outputPath, accumulator.finish(finalStates));
}

export function runMetricAudit(): MetricAuditResult {
  const reportRoot = resolve(AUDIT_RESULTS_ROOT, "metrics");
  mkdirSync(reportRoot, { recursive: true });
  const summaries: { id: string; kind: string; result: ComparisonSummary; evidence: string }[] = [];
  for (const fixture of ["single-linear", "pairwise-contact"] as const) {
    const scenarioPath = resolve("experiments", "audit", "synthetic", `${fixture}-scenario.json`);
    const trajectoryPath = resolve("experiments", "audit", "synthetic", `${fixture}-trajectory.jsonl`);
    const expectedPath = resolve("experiments", "audit", "synthetic", `${fixture}-expected.json`);
    const outputRoot = resolve(reportRoot, "synthetic", fixture);
    mkdirSync(outputRoot, { recursive: true });
    const independentPath = resolve(outputRoot, "independent-metrics.json");
    runPython("experiments/audit/python/evaluate_metrics.py", ["--scenario", scenarioPath, "--trajectory", trajectoryPath, "--out", independentPath]);
    const expectedComparisonPath = resolve(outputRoot, "expected-comparison.json");
    runPython("experiments/audit/python/compare_metrics.py", ["--pipeline", expectedPath, "--independent", independentPath, "--report", expectedComparisonPath]);
    summaries.push({ id: `${fixture}:hand`, kind: "hand-calculated", result: JSON.parse(readFileSync(expectedComparisonPath, "utf8")) as ComparisonSummary, evidence: expectedComparisonPath });
    const pipelinePath = resolve(outputRoot, "pipeline-metrics.json");
    syntheticPipelineMetrics(scenarioPath, trajectoryPath, pipelinePath);
    const pipelineComparisonPath = resolve(outputRoot, "pipeline-comparison.json");
    runPython("experiments/audit/python/compare_metrics.py", ["--pipeline", pipelinePath, "--independent", independentPath, "--report", pipelineComparisonPath]);
    summaries.push({ id: `${fixture}:pipeline`, kind: "production-accumulator", result: JSON.parse(readFileSync(pipelineComparisonPath, "utf8")) as ComparisonSummary, evidence: pipelineComparisonPath });
  }

  const scenarioPath = "experiments/audit/scenarios/single-free-space.json";
  for (const methodPath of METHOD_PATHS) {
    const methodId = (JSON.parse(readFileSync(methodPath, "utf8")) as { id: string }).id;
    const outputRoot = resolve(reportRoot, "real", methodId);
    const run = runAuditedEngine(scenarioPath, methodPath, outputRoot);
    const result = compareIndependent(scenarioPath, run.trajectoryPath, run.metricsPath, outputRoot);
    summaries.push({ id: methodId, kind: "real-trajectory", result, evidence: resolve(outputRoot, "comparison.json") });
  }
  const firstFailure = summaries.find((entry) => entry.result.status !== "PASS");
  const reportPath = resolve(reportRoot, "report.json");
  const report = {
    metricAuditVersion: 1,
    status: firstFailure === undefined ? "PASS" : "FAIL",
    comparisons: summaries,
    maximumAbsoluteDifference: Math.max(...summaries.map((entry) => entry.result.maximumAbsoluteDifference)),
    firstFailure: firstFailure ?? null,
  };
  writeJson(reportPath, report);
  if (firstFailure !== undefined) throw new Error(`Metric audit mismatch in ${firstFailure.id}; see ${firstFailure.evidence}`);
  return {
    status: "PASS",
    comparisons: summaries.length,
    realMethodComparisons: METHOD_PATHS.length,
    maximumAbsoluteDifference: report.maximumAbsoluteDifference,
    reportPath,
  };
}

function main(): void {
  try {
    const result = runMetricAudit();
    console.log(`audit:metrics passed ${result.comparisons} comparisons across ${result.realMethodComparisons} real methods; max difference=${result.maximumAbsoluteDifference}`);
  } catch (error) {
    console.error(`audit:metrics failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) main();
