import type { RunMetrics } from "../../metrics/types";

export interface CandidateRunMetrics {
  candidateId: string;
  methodId: string;
  methodKey: string;
  scenarioId: string;
  family: string;
  variant: string;
  metrics: RunMetrics;
}

export interface CandidateScore {
  candidateId: string;
  methodId: string;
  methodKey: string;
  macroSuccess: number;
  macroOverlapExposure: number;
  macroMaximumPenetration: number;
  macroNormalizedTravelTime: number | null;
  macroRmsAcceleration: number | null;
  runCount: number;
}

export interface CandidateElimination {
  candidateId: string;
  methodKey: string;
  rank: number;
  firstFrontExclusion: string | null;
  score: CandidateScore;
}

export interface SelectionResult {
  ranked: CandidateScore[];
  trace: CandidateElimination[];
}

type MetricName = "success" | "overlap" | "penetration" | "travel" | "acceleration";

export function scoreCandidates(runs: readonly CandidateRunMetrics[]): CandidateScore[] {
  const grouped = new Map<string, CandidateRunMetrics[]>();
  for (const run of runs) {
    const key = `${run.methodId}\0${run.candidateId}`;
    const group = grouped.get(key) ?? [];
    group.push(run);
    grouped.set(key, group);
  }
  return [...grouped.values()].map((candidateRuns): CandidateScore => {
    const first = candidateRuns[0];
    const families = ["pairwise", "circle_antipodal", "bidirectional", "bottleneck"];
    const familyValues = families.map((family) => ({
      success: familyMetric(candidateRuns, family, "success"),
      overlap: familyMetric(candidateRuns, family, "overlap"),
      penetration: familyMetric(candidateRuns, family, "penetration"),
      travel: familyMetric(candidateRuns, family, "travel"),
      acceleration: familyMetric(candidateRuns, family, "acceleration"),
    }));
    if (familyValues.some(({ success, overlap, penetration }) =>
      success === null || overlap === null || penetration === null)) {
      throw new Error(`Candidate ${first.candidateId} lacks a required family metric`);
    }
    return {
      candidateId: first.candidateId,
      methodId: first.methodId,
      methodKey: first.methodKey,
      macroSuccess: mean(familyValues.map(({ success }) => requireNumber(success))),
      macroOverlapExposure: mean(familyValues.map(({ overlap }) => requireNumber(overlap))),
      macroMaximumPenetration: mean(familyValues.map(({ penetration }) => requireNumber(penetration))),
      macroNormalizedTravelTime: meanNullable(familyValues.map(({ travel }) => travel)),
      macroRmsAcceleration: meanNullable(familyValues.map(({ acceleration }) => acceleration)),
      runCount: candidateRuns.length,
    };
  }).sort((first, second) => first.methodId.localeCompare(second.methodId)
    || first.candidateId.localeCompare(second.candidateId));
}

export function rankCandidates(scores: readonly CandidateScore[]): SelectionResult {
  if (scores.length === 0) throw new Error("Cannot rank an empty candidate set");
  const methodIds = new Set(scores.map(({ methodId }) => methodId));
  if (methodIds.size !== 1) throw new Error("Selection must be applied independently per method");
  const firstFront = selectionFront(scores);
  const firstExclusion = new Map<string, string | null>();
  for (const score of scores) firstExclusion.set(score.candidateId, firstFront.exclusions.get(score.candidateId) ?? null);
  const remaining = [...scores];
  const ranked: CandidateScore[] = [];
  while (remaining.length > 0) {
    const front = selectionFront(remaining);
    const ordered = [...front.survivors].sort((first, second) => first.methodKey.localeCompare(second.methodKey));
    if (ordered.length === 0) throw new Error("Selection rule produced an empty front");
    ranked.push(...ordered);
    const selected = new Set(ordered.map(({ candidateId }) => candidateId));
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      if (selected.has(remaining[index].candidateId)) remaining.splice(index, 1);
    }
  }
  return {
    ranked,
    trace: ranked.map((score, index) => ({
      candidateId: score.candidateId,
      methodKey: score.methodKey,
      rank: index + 1,
      firstFrontExclusion: firstExclusion.get(score.candidateId) ?? null,
      score,
    })),
  };
}

function selectionFront(scores: readonly CandidateScore[]): {
  survivors: CandidateScore[];
  exclusions: Map<string, string>;
} {
  let survivors = [...scores];
  const exclusions = new Map<string, string>();
  const filter = (stage: string, retain: (score: CandidateScore) => boolean): void => {
    const next: CandidateScore[] = [];
    for (const score of survivors) {
      if (retain(score)) next.push(score);
      else if (!exclusions.has(score.candidateId)) exclusions.set(score.candidateId, stage);
    }
    survivors = next;
  };
  const bestSuccess = Math.max(...survivors.map(({ macroSuccess }) => macroSuccess));
  filter("success", ({ macroSuccess }) => macroSuccess >= bestSuccess - 0.01);
  const bestOverlap = Math.min(...survivors.map(({ macroOverlapExposure }) => macroOverlapExposure));
  const overlapTolerance = Math.max(0.05 * bestOverlap, 1e-6);
  filter("overlapExposure", ({ macroOverlapExposure }) =>
    macroOverlapExposure <= bestOverlap + overlapTolerance);
  const bestPenetration = Math.min(...survivors.map(({ macroMaximumPenetration }) =>
    macroMaximumPenetration));
  const penetrationTolerance = Math.max(0.05 * bestPenetration, 1e-4);
  filter("maximumPenetration", ({ macroMaximumPenetration }) =>
    macroMaximumPenetration <= bestPenetration + penetrationTolerance);
  const finiteTravel = survivors
    .map(({ macroNormalizedTravelTime }) => macroNormalizedTravelTime)
    .filter((value): value is number => value !== null);
  if (finiteTravel.length > 0) {
    const bestTravel = Math.min(...finiteTravel);
    filter("normalizedTravelTime", ({ macroNormalizedTravelTime }) =>
      macroNormalizedTravelTime !== null && macroNormalizedTravelTime <= bestTravel * 1.01);
  }
  const finiteAcceleration = survivors
    .map(({ macroRmsAcceleration }) => macroRmsAcceleration)
    .filter((value): value is number => value !== null);
  if (finiteAcceleration.length > 0) {
    const bestAcceleration = Math.min(...finiteAcceleration);
    filter("rmsAcceleration", ({ macroRmsAcceleration }) =>
      macroRmsAcceleration !== null && macroRmsAcceleration === bestAcceleration);
  }
  return { survivors, exclusions };
}

function familyMetric(
  runs: readonly CandidateRunMetrics[],
  family: string,
  metric: MetricName,
): number | null {
  const familyRuns = runs.filter((run) => run.family === family);
  if (familyRuns.length === 0) return null;
  if (family === "pairwise") {
    const variants = ["head_on", "crossing", "overtaking", "separating"];
    const values = variants.map((variant) => aggregate(
      familyRuns.filter((run) => run.variant === variant).map((run) => metricValue(run.metrics, metric)),
      metric,
    ));
    return values.some((value) => value === null) ? null : mean(values.map(requireNumber));
  }
  return aggregate(familyRuns.map((run) => metricValue(run.metrics, metric)), metric);
}

function metricValue(metrics: RunMetrics, metric: MetricName): number | null {
  switch (metric) {
    case "success": return metrics.completion.successFraction;
    case "overlap": return metrics.separation.preCorrectionOverlapPairSecondsPerAgentSecond;
    case "penetration": return metrics.separation.maximumPreCorrectionAgentPenetration;
    case "travel": return metrics.travelTime.meanNormalizedTravelTime;
    case "acceleration": return metrics.smoothness.rmsAcceleration;
  }
}

function aggregate(values: readonly (number | null)[], metric: MetricName): number | null {
  const finite = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (finite.length === 0) return null;
  return metric === "success" || metric === "overlap" ? mean(finite) : median(finite);
}

function mean(values: readonly number[]): number {
  if (values.length === 0) throw new Error("Cannot average an empty sequence");
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function meanNullable(values: readonly (number | null)[]): number | null {
  return values.some((value) => value === null) ? null : mean(values.map(requireNumber));
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((first, second) => first - second);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
}

function requireNumber(value: number | null): number {
  if (value === null) throw new Error("Required aggregate is null");
  return value;
}
