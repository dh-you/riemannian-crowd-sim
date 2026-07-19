import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunMetrics } from "../../experiments/metrics/types";
import { sha256File } from "../../experiments/protocol/hash";
import { rankCandidates, scoreCandidates, type CandidateRunMetrics } from "../../experiments/studies/stage-d/selection";
import { bootstrapPairedDifference } from "../../experiments/studies/stage-d/statistics/bootstrap";
import type { AnalysisDatum } from "../../experiments/studies/stage-d/statistics/aggregation";
import { DeterministicBootstrapRandom } from "../../experiments/studies/stage-d/statistics/deterministicRandom";

describe("Stage D preregistration and analysis tooling", () => {
  it("locks the plan inputs and equal candidate budgets before validation", () => {
    const plan = json("experiments/studies/stage-d/plan/study-plan.json") as {
      lockedPlanInputs: Record<string, string>;
      statisticsPolicy: { bootstrapSeed: number; bootstrapReplicates: number; confidenceLevel: number };
    };
    expect(sha256File("experiments/studies/stage-d/plan/metric-policy.json"))
      .toBe(plan.lockedPlanInputs.metricPolicySha256);
    expect(sha256File("experiments/studies/stage-d/plan/candidate-space.json"))
      .toBe(plan.lockedPlanInputs.candidateSpaceSha256);
    expect(sha256File("experiments/studies/stage-d/plan/scenario-partitions.json"))
      .toBe(plan.lockedPlanInputs.scenarioPartitionsSha256);
    const candidates = json("experiments/studies/stage-d/plan/candidate-space.json") as {
      methods: Record<string, { candidateCount: number }>;
    };
    expect(candidates.methods.conditioned_riemannian_metric_v1.candidateCount).toBe(17);
    expect(candidates.methods.orca_rvo2_v1.candidateCount).toBe(18);
    expect(candidates.methods.social_force_pysocialforce_v1.candidateCount).toBe(18);
    expect(Object.values(candidates.methods).every(({ candidateCount }) => candidateCount <= 18)).toBe(true);
    expect(plan.statisticsPolicy).toMatchObject({
      bootstrapSeed: 20260718,
      bootstrapReplicates: 10000,
      confidenceLevel: 0.95,
    });
  });

  it("uses the preregistered hierarchical selection tolerances deterministically", () => {
    const runs = [
      ...candidateRuns("a", "key-a", 1, 0.1, 0.02, 1.1, 2),
      ...candidateRuns("b", "key-b", 0.995, 0.05, 0.01, 1.2, 3),
      ...candidateRuns("c", "key-c", 0.9, 0, 0, 1, 1),
    ];
    const result = rankCandidates(scoreCandidates(runs));
    expect(result.ranked.map(({ candidateId }) => candidateId)).toEqual(["b", "a", "c"]);
    expect(result.trace.find(({ candidateId }) => candidateId === "a")?.firstFrontExclusion)
      .toBe("overlapExposure");
    expect(result.trace.find(({ candidateId }) => candidateId === "c")?.firstFrontExclusion)
      .toBe("success");
  });

  it("produces deterministic paired stratified bootstrap intervals", () => {
    const proposed = analysisData("proposed", [1, 2, 3, 4, 5, 6, 7]);
    const comparator = analysisData("comparator", [0, 1, 2, 3, 4, 5, 6]);
    const first = bootstrapPairedDifference(
      proposed,
      comparator,
      "value",
      "mean",
      "overall",
      20260718,
      500,
      0.95,
    );
    const second = bootstrapPairedDifference(
      proposed,
      comparator,
      "value",
      "mean",
      "overall",
      20260718,
      500,
      0.95,
    );
    expect(first).toEqual(second);
    expect(first.lower).toBeCloseTo(1, 15);
    expect(first.upper).toBeCloseTo(1, 15);
    const random = new DeterministicBootstrapRandom(20260718);
    expect([random.next(), random.next(), random.next()]).toEqual([
      0.5667457529343665,
      0.9956677507143468,
      0.7501200868282467,
    ]);
  });

  it("keeps test materialization behind freeze and exposes all required commands and guards", () => {
    const phaseRunner = readFileSync(resolve("experiments/studies/stage-d/phaseRunner.ts"), "utf8");
    const freeze = readFileSync(resolve("experiments/studies/stage-d/cli/freezeConfigurations.ts"), "utf8");
    const test = readFileSync(resolve("experiments/studies/stage-d/cli/runFrozenTest.ts"), "utf8");
    expect(phaseRunner).not.toContain("materializeFrozenTestScenarios");
    expect(freeze).toContain("materializeFrozenTestScenarios");
    for (const option of ["--shard-index", "--shard-count", "--jobs", "--resume", "--fail-fast"]) {
      expect(test).toContain(option);
    }
    expect(test).toContain("Freeze Stage D method configurations");
    const scripts = (json("package.json") as { scripts: Record<string, string> }).scripts;
    for (const name of [
      "study:d:plan",
      "study:d:candidates",
      "study:d:screen",
      "study:d:validation",
      "study:d:select",
      "study:d:freeze",
      "study:d:test",
      "study:d:merge",
      "study:d:ablations",
      "study:d:runtime",
      "study:d:analyze",
      "study:d:paper",
      "study:d:verify",
    ]) expect(scripts[name]).toBeTypeOf("string");
  });
});

function json(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as unknown;
}

function candidateRuns(
  candidateId: string,
  methodKey: string,
  success: number,
  overlap: number,
  penetration: number,
  travel: number,
  acceleration: number,
): CandidateRunMetrics[] {
  const definitions = [
    ["pairwise", "head_on", 0],
    ["pairwise", "crossing", 1],
    ["pairwise", "overtaking", 2],
    ["pairwise", "separating", 3],
    ["circle_antipodal", "perturbed", 0],
    ["bidirectional", "corridor", 0],
    ["bottleneck", "central_opening", 0],
  ] as const;
  return definitions.map(([family, variant, seed]) => ({
    candidateId,
    methodId: "conditioned_riemannian_metric_v1",
    methodKey,
    scenarioId: `${family}/${variant}/${seed}`,
    family,
    variant,
    metrics: {
      completion: { successFraction: success },
      separation: {
        preCorrectionOverlapPairSecondsPerAgentSecond: overlap,
        maximumPreCorrectionAgentPenetration: penetration,
      },
      travelTime: { meanNormalizedTravelTime: travel },
      smoothness: { rmsAcceleration: acceleration },
    } as RunMetrics,
  }));
}

function analysisData(methodId: string, values: readonly number[]): AnalysisDatum[] {
  const definitions = [
    ["pairwise", "head_on"],
    ["pairwise", "crossing"],
    ["pairwise", "overtaking"],
    ["pairwise", "separating"],
    ["circle_antipodal", "perturbed"],
    ["bidirectional", "corridor"],
    ["bottleneck", "central_opening"],
  ] as const;
  return definitions.map(([family, variant], index) => ({
    scenarioId: `${family}/${variant}/0`,
    family,
    variant,
    methodId,
    methodKey: methodId,
    values: { value: values[index] },
  }));
}
