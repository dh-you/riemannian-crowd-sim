import { macroEstimate, type AnalysisDatum, type Estimator } from "./aggregation";
import { DeterministicBootstrapRandom } from "./deterministicRandom";

export interface BootstrapInterval {
  lower: number | null;
  upper: number | null;
  replicateCount: number;
}

export function bootstrapMethodInterval(
  data: readonly AnalysisDatum[],
  metric: string,
  estimator: Estimator,
  scope: "overall" | "pairwise" | "bottleneck",
  seed: number,
  replicates: number,
  confidenceLevel: number,
): BootstrapInterval {
  const random = new DeterministicBootstrapRandom(seed);
  const values: number[] = [];
  for (let replicate = 0; replicate < replicates; replicate += 1) {
    const sampled = stratifiedSample(data, random);
    const value = macroEstimate(sampled, metric, estimator, scope);
    if (value !== null) values.push(value);
  }
  return interval(values, replicates, confidenceLevel);
}

export function bootstrapPairedDifference(
  proposed: readonly AnalysisDatum[],
  comparator: readonly AnalysisDatum[],
  metric: string,
  estimator: Estimator,
  scope: "overall" | "pairwise" | "bottleneck",
  seed: number,
  replicates: number,
  confidenceLevel: number,
): BootstrapInterval {
  const proposedByScenario = new Map(proposed.map((datum) => [datum.scenarioId, datum]));
  const comparatorByScenario = new Map(comparator.map((datum) => [datum.scenarioId, datum]));
  if (proposedByScenario.size !== comparatorByScenario.size
    || [...proposedByScenario.keys()].some((key) => !comparatorByScenario.has(key))) {
    throw new Error("Paired bootstrap requires identical scenario identities");
  }
  const pairs = [...proposedByScenario.values()].map((first) => ({
    first,
    second: comparatorByScenario.get(first.scenarioId) as AnalysisDatum,
  }));
  const strata = groupPairIndices(pairs);
  const random = new DeterministicBootstrapRandom(seed);
  const values: number[] = [];
  for (let replicate = 0; replicate < replicates; replicate += 1) {
    const firstSample: AnalysisDatum[] = [];
    const secondSample: AnalysisDatum[] = [];
    for (const indices of strata.values()) {
      for (let index = 0; index < indices.length; index += 1) {
        const chosen = pairs[indices[random.integer(indices.length)]];
        firstSample.push(chosen.first);
        secondSample.push(chosen.second);
      }
    }
    const firstValue = macroEstimate(firstSample, metric, estimator, scope);
    const secondValue = macroEstimate(secondSample, metric, estimator, scope);
    if (firstValue !== null && secondValue !== null) values.push(firstValue - secondValue);
  }
  return interval(values, replicates, confidenceLevel);
}

function stratifiedSample(
  data: readonly AnalysisDatum[],
  random: DeterministicBootstrapRandom,
): AnalysisDatum[] {
  const strata = new Map<string, AnalysisDatum[]>();
  for (const datum of data) {
    const key = datum.family === "pairwise" ? `pairwise/${datum.variant}` : datum.family;
    const group = strata.get(key) ?? [];
    group.push(datum);
    strata.set(key, group);
  }
  const sampled: AnalysisDatum[] = [];
  for (const group of strata.values()) {
    for (let index = 0; index < group.length; index += 1) {
      sampled.push(group[random.integer(group.length)]);
    }
  }
  return sampled;
}

function groupPairIndices(
  pairs: readonly { first: AnalysisDatum }[],
): Map<string, number[]> {
  const result = new Map<string, number[]>();
  for (const [index, pair] of pairs.entries()) {
    const datum = pair.first;
    const key = datum.family === "pairwise" ? `pairwise/${datum.variant}` : datum.family;
    const group = result.get(key) ?? [];
    group.push(index);
    result.set(key, group);
  }
  return result;
}

function interval(
  values: readonly number[],
  expectedReplicates: number,
  confidenceLevel: number,
): BootstrapInterval {
  if (values.length === 0) return { lower: null, upper: null, replicateCount: 0 };
  if (values.length !== expectedReplicates) {
    throw new Error(`Bootstrap produced ${values.length}/${expectedReplicates} finite replicates`);
  }
  const alpha = (1 - confidenceLevel) / 2;
  return {
    lower: percentile(values, alpha),
    upper: percentile(values, 1 - alpha),
    replicateCount: values.length,
  };
}

function percentile(values: readonly number[], probability: number): number {
  const ordered = [...values].sort((first, second) => first - second);
  const index = Math.max(0, Math.min(ordered.length - 1, Math.floor(probability * ordered.length)));
  return ordered[index];
}
