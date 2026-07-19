import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { RunMetrics } from "../../../metrics/types";
import { sha256File } from "../../../protocol/hash";
import { FREEZE_MANIFEST_PATH, type FreezeManifest } from "./freezeConfigurations";
import type { FrozenTestShardManifest } from "./runFrozenTest";
import type { PhaseManifest } from "../phaseRunner";
import {
  contributingCount,
  macroEstimate,
  familyEstimate,
  estimate,
  type AnalysisDatum,
  type Estimator,
} from "../statistics/aggregation";
import { bootstrapMethodInterval, bootstrapPairedDifference } from "../statistics/bootstrap";
import {
  RESULTS_ROOT,
  currentGitHead,
  phaseManifestPath,
  readJson,
  verifyPreregisteredPlan,
  writeJson,
} from "../studyPaths";

interface MetricDefinition {
  id: string;
  estimator: Estimator;
  scope: "overall" | "pairwise" | "bottleneck";
  unit: string;
}

const METRICS: MetricDefinition[] = [
  { id: "success_fraction", estimator: "mean", scope: "overall", unit: "fraction" },
  { id: "pre_correction_overlap_exposure", estimator: "mean", scope: "overall", unit: "pair-s per agent-s" },
  { id: "maximum_pre_correction_penetration", estimator: "median", scope: "overall", unit: "m" },
  { id: "normalized_travel_time", estimator: "median", scope: "overall", unit: "ratio conditional on success" },
  { id: "path_ratio", estimator: "median", scope: "overall", unit: "path length / straight-line distance" },
  { id: "rms_acceleration", estimator: "median", scope: "overall", unit: "m/s^2" },
  { id: "rms_jerk", estimator: "median", scope: "overall", unit: "m/s^3" },
  { id: "correction_ratio", estimator: "median", scope: "overall", unit: "ratio" },
  { id: "throughput", estimator: "mean", scope: "bottleneck", unit: "agents/s" },
  { id: "avoidance_onset_rate", estimator: "mean", scope: "pairwise", unit: "fraction" },
  { id: "ttc_at_onset", estimator: "median", scope: "pairwise", unit: "s" },
  { id: "minimum_pre_correction_physical_clearance", estimator: "median", scope: "pairwise", unit: "m" },
  { id: "minimum_post_correction_physical_clearance", estimator: "median", scope: "pairwise", unit: "m" },
];

interface MainResultRow {
  methodId: string;
  methodKey: string;
  engineId: string;
  upstreamCommit: string | null;
  repositoryCommit: string;
  freezeManifestSha256: string;
  scenarioSet: string;
  metric: string;
  unit: string;
  scope: string;
  estimator: Estimator;
  estimate: number | null;
  confidenceLower: number | null;
  confidenceUpper: number | null;
  contributingScenarios: number;
  bootstrapReplicates: number;
}

export function analyzeResults(): { mainResults: MainResultRow[]; pairedDifferences: unknown[] } {
  const plan = verifyPreregisteredPlan();
  const freeze = readJson<FreezeManifest>(FREEZE_MANIFEST_PATH);
  const merged = readJson<{
    status: string;
    completedRunCount: number;
    runs: FrozenTestShardManifest["completed"];
  }>(resolve(RESULTS_ROOT, "test/merged-test-manifest.json"));
  if (merged.status !== "PASS" || merged.completedRunCount !== freeze.expectedTestRunCount) {
    throw new Error("Complete frozen test merge is required before analysis");
  }
  const scenarioById = new Map(freeze.testScenarios.map((scenario) => [scenario.scenarioId, scenario]));
  const methodById = new Map(freeze.frozenMethods.map((method) => [method.methodId, method]));
  const data: AnalysisDatum[] = merged.runs.map((run) => {
    const scenario = scenarioById.get(run.scenarioId);
    const method = methodById.get(run.methodId);
    if (scenario === undefined || method === undefined) throw new Error("Merged run has unknown frozen identity");
    const metrics = readJson<RunMetrics>(run.metricsPath);
    if (metrics.identity.methodKey !== method.methodKey || containsNonFinite(metrics)) {
      throw new Error(`Invalid frozen metric artifact: ${run.metricsPath}`);
    }
    return {
      scenarioId: run.scenarioId,
      family: scenario.family,
      variant: scenario.variant,
      methodId: run.methodId,
      methodKey: run.methodKey,
      values: metricValues(metrics),
    };
  });
  const freezeHash = sha256File(FREEZE_MANIFEST_PATH);
  const mainResults: MainResultRow[] = [];
  for (const method of freeze.frozenMethods) {
    const methodData = data.filter(({ methodId }) => methodId === method.methodId);
    if (methodData.length !== freeze.testScenarios.length) throw new Error(`Incomplete method data: ${method.methodId}`);
    for (const metric of METRICS) {
      const interval = bootstrapMethodInterval(
        methodData,
        metric.id,
        metric.estimator,
        metric.scope,
        plan.statisticsPolicy.bootstrapSeed + stableOffset(method.methodId, metric.id),
        plan.statisticsPolicy.bootstrapReplicates,
        plan.statisticsPolicy.confidenceLevel,
      );
      mainResults.push({
        methodId: method.methodId,
        methodKey: method.methodKey,
        engineId: method.engineId,
        upstreamCommit: method.upstreamCommit,
        repositoryCommit: currentGitHead(),
        freezeManifestSha256: freezeHash,
        scenarioSet: metric.scope === "overall" ? "frozen_test_290" : `frozen_test_${metric.scope}`,
        metric: metric.id,
        unit: metric.unit,
        scope: metric.scope,
        estimator: metric.estimator,
        estimate: macroEstimate(methodData, metric.id, metric.estimator, metric.scope),
        confidenceLower: interval.lower,
        confidenceUpper: interval.upper,
        contributingScenarios: contributingCount(methodData, metric.id, metric.scope),
        bootstrapReplicates: interval.replicateCount,
      });
    }
  }

  const proposed = data.filter(({ methodId }) => methodId === "conditioned_riemannian_metric_v1");
  const pairedDifferences: Array<Record<string, unknown>> = [];
  for (const comparator of freeze.frozenMethods.filter(({ methodId }) =>
    methodId !== "conditioned_riemannian_metric_v1")) {
    const comparatorData = data.filter(({ methodId }) => methodId === comparator.methodId);
    for (const metric of METRICS) {
      const proposedEstimate = macroEstimate(proposed, metric.id, metric.estimator, metric.scope);
      const comparatorEstimate = macroEstimate(comparatorData, metric.id, metric.estimator, metric.scope);
      const interval = bootstrapPairedDifference(
        proposed,
        comparatorData,
        metric.id,
        metric.estimator,
        metric.scope,
        plan.statisticsPolicy.bootstrapSeed + stableOffset(comparator.methodId, metric.id),
        plan.statisticsPolicy.bootstrapReplicates,
        plan.statisticsPolicy.confidenceLevel,
      );
      pairedDifferences.push({
        proposedMethodId: "conditioned_riemannian_metric_v1",
        proposedMethodKey: methodById.get("conditioned_riemannian_metric_v1")?.methodKey,
        comparatorMethodId: comparator.methodId,
        comparatorMethodKey: comparator.methodKey,
        metric: metric.id,
        unit: metric.unit,
        scope: metric.scope,
        differenceDefinition: "Conditioned Riemannian minus comparator",
        proposedEstimate,
        comparatorEstimate,
        pairedDifference: proposedEstimate === null || comparatorEstimate === null
          ? null
          : proposedEstimate - comparatorEstimate,
        confidenceLower: interval.lower,
        confidenceUpper: interval.upper,
        pairedScenarioCount: contributingCount(proposed, metric.id, metric.scope),
        bootstrapReplicates: interval.replicateCount,
        freezeManifestSha256: freezeHash,
      });
    }
  }
  const perFamily = buildPerFamily(data, freeze, freezeHash);
  const ablationRows = buildAblationResults();
  const sensitivityRows = buildSensitivityResults();
  const failures = buildFailureSummary();
  const compactRoot = resolve(RESULTS_ROOT, "compact");
  writeJson(resolve(compactRoot, "main-results.json"), {
    analysisVersion: 1,
    status: "PASS",
    statisticsPolicy: plan.statisticsPolicy,
    mainResults,
    pairedDifferences,
  });
  writeCsv(resolve(compactRoot, "main-results.csv"), mainResults.map((row) => ({ ...row })));
  writeCsv(resolve(compactRoot, "per-family-results.csv"), perFamily);
  writeCsv(resolve(compactRoot, "paired-differences.csv"), pairedDifferences);
  writeCsv(resolve(compactRoot, "ablation-results.csv"), ablationRows);
  writeCsv(resolve(compactRoot, "sensitivity-results.csv"), sensitivityRows);
  writeCsv(resolve(compactRoot, "failure-summary.csv"), failures);
  writeJson(phaseManifestPath("analysis"), {
    analysisManifestVersion: 1,
    status: "PASS",
    repositoryCommit: currentGitHead(),
    freezeManifestSha256: freezeHash,
    mergedTestManifestSha256: sha256File(resolve(RESULTS_ROOT, "test/merged-test-manifest.json")),
    inputRunCount: data.length,
    outputRowCounts: {
      mainResults: mainResults.length,
      perFamily: perFamily.length,
      pairedDifferences: pairedDifferences.length,
      ablations: ablationRows.length,
      sensitivity: sensitivityRows.length,
      failures: failures.length,
    },
  });
  return { mainResults, pairedDifferences };
}

function metricValues(metrics: RunMetrics): Record<string, number | null> {
  const pathRatios = metrics.completion.perAgent
    .map(({ pathEfficiency }) => pathEfficiency === null || pathEfficiency <= 0 ? null : 1 / pathEfficiency)
    .filter((value): value is number => value !== null);
  const pairwiseAgents = metrics.pairwise?.perAgent ?? [];
  const ttcValues = pairwiseAgents.map(({ ttcAtAvoidanceOnset }) => ttcAtAvoidanceOnset);
  return {
    success_fraction: metrics.completion.successFraction,
    pre_correction_overlap_exposure: metrics.separation.preCorrectionOverlapPairSecondsPerAgentSecond,
    maximum_pre_correction_penetration: metrics.separation.maximumPreCorrectionAgentPenetration,
    normalized_travel_time: metrics.travelTime.meanNormalizedTravelTime,
    path_ratio: pathRatios.length === 0 ? null : estimate(pathRatios, "mean"),
    rms_acceleration: metrics.smoothness.rmsAcceleration,
    rms_jerk: metrics.smoothness.rmsJerk,
    correction_ratio: metrics.correctionDependence.correctionRatio,
    throughput: metrics.throughput,
    avoidance_onset_rate: metrics.pairwise === null
      ? null
      : pairwiseAgents.filter(({ avoidanceOnsetTime }) => avoidanceOnsetTime !== null).length / pairwiseAgents.length,
    ttc_at_onset: estimate(ttcValues, "median"),
    minimum_pre_correction_physical_clearance: metrics.pairwise?.minimumPreCorrectionPhysicalClearance ?? null,
    minimum_post_correction_physical_clearance: metrics.pairwise?.minimumPostCorrectionPhysicalClearance ?? null,
  };
}

function buildPerFamily(
  data: readonly AnalysisDatum[],
  freeze: FreezeManifest,
  freezeHash: string,
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const method of freeze.frozenMethods) {
    const methodData = data.filter(({ methodId }) => methodId === method.methodId);
    for (const family of ["pairwise", "circle_antipodal", "bidirectional", "bottleneck"]) {
      for (const metric of METRICS.filter(({ scope }) => scope === "overall"
        || scope === family)) {
        rows.push({
          family,
          methodId: method.methodId,
          methodKey: method.methodKey,
          engineId: method.engineId,
          upstreamCommit: method.upstreamCommit,
          metric: metric.id,
          unit: metric.unit,
          estimator: metric.estimator,
          estimate: familyEstimate(methodData, family, metric.id, metric.estimator),
          contributingScenarios: methodData.filter((datum) =>
            datum.family === family && datum.values[metric.id] !== null).length,
          freezeManifestSha256: freezeHash,
        });
      }
    }
  }
  return rows;
}

function buildAblationResults(): Array<Record<string, unknown>> {
  const manifest = readJson<{
    status: string;
    runs: Array<{ ablation: string; scenarioId: string; methodKey: string; metricsPath: string }>;
  }>(phaseManifestPath("ablations"));
  if (manifest.status !== "PASS") throw new Error("Ablation manifest is not passing");
  const scenarioManifest = readJson<{ scenarios: Array<{ scenarioId: string; family: string; variant: string }> }>(
    resolve(RESULTS_ROOT, "scenarios/validationHoldout/scenario-manifest.json"),
  );
  const scenarioById = new Map(scenarioManifest.scenarios.map((scenario) => [scenario.scenarioId, scenario]));
  const names = [...new Set(manifest.runs.map(({ ablation }) => ablation))].sort();
  const rows: Array<Record<string, unknown>> = [];
  for (const name of names) {
    const runs = manifest.runs.filter(({ ablation }) => ablation === name).map((run): AnalysisDatum => {
      const scenario = scenarioById.get(run.scenarioId);
      if (scenario === undefined) throw new Error("Unknown ablation scenario");
      return {
        scenarioId: run.scenarioId,
        family: scenario.family,
        variant: scenario.variant,
        methodId: name,
        methodKey: run.methodKey,
        values: metricValues(readJson<RunMetrics>(run.metricsPath)),
      };
    });
    for (const metric of METRICS.filter(({ scope }) => scope === "overall")) {
      rows.push({
        ablation: name,
        methodKey: runs[0].methodKey,
        scenarioSet: "validation_holdout_22",
        metric: metric.id,
        unit: metric.unit,
        estimator: metric.estimator,
        estimate: macroEstimate(runs, metric.id, metric.estimator, "overall"),
        contributingScenarios: contributingCount(runs, metric.id, "overall"),
      });
    }
  }
  return rows;
}

function buildSensitivityResults(): Array<Record<string, unknown>> {
  const screening = readJson<PhaseManifest>(phaseManifestPath("screening"));
  const trace = screening.selection.conditioned_riemannian_metric_v1?.trace ?? [];
  const axes: Record<string, string[]> = {
    alpha: ["riemannian-01-alpha-low", "riemannian-00-default", "riemannian-02-alpha-high"],
    sigma: ["riemannian-03-sigma-low", "riemannian-00-default", "riemannian-04-sigma-high"],
    rho: ["riemannian-05-rho-low", "riemannian-00-default", "riemannian-06-rho-high"],
    velocityTimeConstant: ["riemannian-07-tau-immediate", "riemannian-00-default", "riemannian-08-tau-slow"],
  };
  return Object.entries(axes).flatMap(([axis, ids]) => ids.map((candidateId) => {
    const entry = trace.find((candidate) => candidate.candidateId === candidateId);
    if (entry === undefined) {
      return { axis, candidateId, status: "INVALID_OR_FAILED", fixedReference: "preregistered_default" };
    }
    return {
      axis,
      candidateId,
      methodKey: entry.methodKey,
      status: "VALID",
      fixedReference: "preregistered_default",
      macroSuccess: entry.score.macroSuccess,
      macroOverlapExposure: entry.score.macroOverlapExposure,
      macroMaximumPenetration: entry.score.macroMaximumPenetration,
      macroNormalizedTravelTime: entry.score.macroNormalizedTravelTime,
      macroRmsAcceleration: entry.score.macroRmsAcceleration,
    };
  }));
}

function buildFailureSummary(): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const phase of ["screening", "validation-tuning", "validation-holdout"]) {
    const manifest = readJson<PhaseManifest>(phaseManifestPath(phase));
    for (const failure of manifest.failures) rows.push({ phase, ...failure });
  }
  return rows;
}

function stableOffset(first: string, second: string): number {
  let hash = 2166136261;
  for (const character of `${first}\0${second}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function writeCsv(path: string, rows: readonly Record<string, unknown>[]): void {
  mkdirSync(dirname(path), { recursive: true });
  if (rows.length === 0) {
    writeFileSync(path, "\n", "utf8");
    return;
  }
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const lines = [columns.join(","), ...rows.map((row) => columns.map((column) => csv(row[column])).join(","))];
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
}

function csv(value: unknown): string {
  if (value === undefined || value === null) return "";
  const text = String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function containsNonFinite(value: unknown): boolean {
  if (typeof value === "number") return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some(containsNonFinite);
  if (value !== null && typeof value === "object") return Object.values(value).some(containsNonFinite);
  return false;
}

function main(): void {
  try {
    const result = analyzeResults();
    console.log(`study:d:analyze PASS: ${result.mainResults.length} estimates, ${result.pairedDifferences.length} paired differences`);
  } catch (error) {
    console.error(`study:d:analyze failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) main();
