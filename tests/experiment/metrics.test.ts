import { describe, expect, it } from "vitest";
import { constantVelocityTimeToContact } from "../../experiments/metrics/geometry";
import {
  PAIRWISE_AVOIDANCE_THRESHOLD_DEGREES,
  RunMetricsAccumulator,
} from "../../experiments/metrics/RunMetricsAccumulator";
import type { ExperimentScenario } from "../../experiments/protocol/schema";
import type { AgentState, StepDiagnostics, Vec2 } from "../../src/core/types";

describe("online common metrics", () => {
  it("computes analytical arrival, travel, path, exposure, correction, smoothness, and throughput", () => {
    const initial = agent(0, [0, 0], [0, 0], [1, 0], false);
    const scenario = scenarioOf([initial], "free_space", 1);
    const after = agent(0, [1, 0], [1, 0], [1, 0], true);
    const diagnostic = stepDiagnostic(0, 1, initial, after, [1, 0], {
      preCorrectionOverlapPairs: 2,
      postCorrectionOverlapPairs: 1,
      maxPreCorrectionPenetration: 0.2,
      maxPostCorrectionPenetration: 0.05,
      minimumPreCorrectionClearance: -0.2,
      intendedDisplacement: 1,
      agentCorrectionDisplacement: 0.25,
      wallCorrectionDisplacement: 0.25,
    });
    const accumulator = new RunMetricsAccumulator(scenario, "analytical");
    accumulator.observeStep([initial], diagnostic, [after]);
    const metrics = accumulator.finish([after]);

    expect(metrics.completion.agentsReachedGoal).toBe(1);
    expect(metrics.completion.perAgent[0]).toEqual({
      id: 0,
      firstArrivalTime: 1,
      normalizedTravelTime: 1,
      pathEfficiency: 1,
    });
    expect(metrics.travelTime.meanNormalizedTravelTime).toBe(1);
    expect(metrics.pathEfficiency.meanPathEfficiency).toBe(1);
    expect(metrics.separation.totalPreCorrectionOverlapPairSeconds).toBe(2);
    expect(metrics.separation.totalPostCorrectionOverlapPairSeconds).toBe(1);
    expect(metrics.separation.preCorrectionOverlapPairSecondsPerAgentSecond).toBe(2);
    expect(metrics.separation.maximumPreCorrectionPenetration).toBe(0.2);
    expect(metrics.correctionDependence.totalCorrectionDisplacement).toBe(0.5);
    expect(metrics.correctionDependence.correctionRatio).toBeCloseTo(0.5 / (1 + 1e-12), 15);
    expect(metrics.smoothness.rmsAcceleration).toBe(1);
    expect(metrics.smoothness.rmsJerk).toBeNull();
    expect(metrics.throughput).toBe(1);
  });

  it("uses realized velocity, initial velocity, physical dt, and explicit sample denominators", () => {
    const initial = agent(0, [0, 0], [0, 0], [20, 0], false);
    const first = agent(0, [1, 0], [1, 0], [20, 0], false);
    const second = agent(0, [4, 0], [3, 0], [20, 0], false);
    const accumulator = new RunMetricsAccumulator(scenarioOf([initial], "free_space", 1), "analytical");
    accumulator.observeStep([initial], stepDiagnostic(0, 1, initial, first, [1, 0]), [first]);
    accumulator.observeStep([first], stepDiagnostic(1, 2, first, second, [3, 0]), [second]);
    const metrics = accumulator.finish([second]);
    expect(metrics.smoothness.accelerationSampleCount).toBe(2);
    expect(metrics.smoothness.jerkSampleCount).toBe(1);
    expect(metrics.smoothness.rmsAcceleration).toBeCloseTo(Math.sqrt(2.5), 15);
    expect(metrics.smoothness.rmsJerk).toBe(1);
    expect(metrics.completion.successFraction).toBe(0);
    expect(metrics.travelTime.meanNormalizedTravelTime).toBeNull();
    expect(metrics.pathEfficiency.meanPathEfficiency).toBeNull();
  });

  it("excludes all samples after first arrival without latching simulator state", () => {
    const initial = agent(0, [0, 0], [0, 0], [1, 0], false);
    const arrived = agent(0, [1, 0], [1, 0], [1, 0], true);
    const later = agent(0, [2, 0], [100, 0], [1, 0], false);
    const accumulator = new RunMetricsAccumulator(scenarioOf([initial], "free_space", 1), "analytical");
    accumulator.observeStep([initial], stepDiagnostic(0, 1, initial, arrived, [1, 0]), [arrived]);
    accumulator.observeStep([arrived], stepDiagnostic(1, 2, arrived, later, [100, 0]), [later]);
    const metrics = accumulator.finish([later]);
    expect(metrics.completion.perAgent[0].firstArrivalTime).toBe(1);
    expect(metrics.completion.finalArrivedFraction).toBe(0);
    expect(metrics.smoothness.accelerationSampleCount).toBe(1);
  });

  it("uses explicit nulls for zero-duration and unavailable metrics", () => {
    const initial = agent(0, [0, 0], [0, 0], [10, 0], false);
    const metrics = new RunMetricsAccumulator(scenarioOf([initial], "free_space", 1), "analytical").finish([
      initial,
    ]);
    expect(metrics.identity.simulatedDuration).toBe(0);
    expect(metrics.throughput).toBeNull();
    expect(metrics.smoothness.rmsAcceleration).toBeNull();
    expect(metrics.smoothness.rmsJerk).toBeNull();
    expect(metrics.separation.preCorrectionOverlapPairSecondsPerAgentSecond).toBeNull();
    expect(metrics.completion.perAgent[0].firstArrivalTime).toBeNull();
    expect(JSON.stringify(metrics)).not.toMatch(/NaN|Infinity/u);
  });
});

describe("pairwise anticipation geometry and metrics", () => {
  it("solves the earliest constant-velocity circular contact root", () => {
    expect(constantVelocityTimeToContact([4, 0], [-2, 0], 0.6)).toBeCloseTo(1.7, 15);
    expect(constantVelocityTimeToContact([0.5, 0], [-2, 0], 0.6)).toBe(0);
  });

  it("returns null for separating, stationary, missed, or invalid encounters", () => {
    expect(constantVelocityTimeToContact([4, 0], [2, 0], 0.6)).toBeNull();
    expect(constantVelocityTimeToContact([4, 0], [0, 0], 0.6)).toBeNull();
    expect(constantVelocityTimeToContact([4, 4], [-2, 0], 0.6)).toBeNull();
    expect(constantVelocityTimeToContact([Number.NaN, 0], [-2, 0], 0.6)).toBeNull();
  });

  it("records onset only when target deflection crosses above five degrees", () => {
    const first = agent(0, [-2, 0], [1, 0], [2, 0], false);
    const second = agent(1, [2, 0], [-1, 0], [-2, 0], false);
    const scenario = scenarioOf([first, second], "pairwise", 1);
    const deflected: Vec2 = [Math.cos(Math.PI / 30), Math.sin(Math.PI / 30)];
    const diagnostic = twoAgentDiagnostic(0, 1, first, second, deflected, [-1, 0]);
    const accumulator = new RunMetricsAccumulator(scenario, "analytical");
    accumulator.observeStep([first, second], diagnostic, [first, second]);
    const pairwise = accumulator.finish([first, second]).pairwise;
    expect(PAIRWISE_AVOIDANCE_THRESHOLD_DEGREES).toBe(5);
    expect(pairwise?.perAgent[0].avoidanceOnsetTime).toBe(0);
    expect(pairwise?.perAgent[0].ttcAtAvoidanceOnset).toBeCloseTo(1.7, 15);
    expect(pairwise?.perAgent[1].avoidanceOnsetTime).toBeNull();
    expect(pairwise?.minimumCenterClearance).toBe(4);
    expect(pairwise?.minimumPhysicalClearance).toBeCloseTo(3.4, 15);
  });

  it("does not declare onset for zero target or deflection below the threshold", () => {
    const first = agent(0, [-2, 0], [1, 0], [2, 0], false);
    const second = agent(1, [2, 0], [-1, 0], [-2, 0], false);
    const angle = (4 * Math.PI) / 180;
    const accumulator = new RunMetricsAccumulator(scenarioOf([first, second], "pairwise", 1), "analytical");
    accumulator.observeStep(
      [first, second],
      twoAgentDiagnostic(0, 1, first, second, [Math.cos(angle), Math.sin(angle)], [0, 0]),
      [first, second],
    );
    const pairwise = accumulator.finish([first, second]).pairwise;
    expect(pairwise?.perAgent.every(({ avoidanceOnsetTime }) => avoidanceOnsetTime === null)).toBe(true);
  });
});

function scenarioOf(agents: AgentState[], family: string, dt: number): ExperimentScenario {
  return {
    experimentScenarioVersion: 1,
    name: "analytical",
    family,
    variant: "fixture",
    split: "test",
    seed: 0,
    simulation: {
      dt,
      horizonSeconds: 10,
      goalTolerance: 0.01,
      correction: { enabled: false, iterations: 0, padding: 0 },
    },
    agents,
    walls: [],
    metadata: { units: { distance: "m", time: "s" } },
  };
}

function agent(
  id: number,
  position: Vec2,
  velocity: Vec2,
  goal: Vec2,
  arrived: boolean,
): AgentState {
  return { id, position, velocity, goal, arrived, radius: 0.3, preferredSpeed: 1 };
}

type DiagnosticOverrides = Partial<
  Pick<
    StepDiagnostics,
    | "preCorrectionOverlapPairs"
    | "postCorrectionOverlapPairs"
    | "maxPreCorrectionPenetration"
    | "maxPostCorrectionPenetration"
    | "minimumPreCorrectionClearance"
    | "intendedDisplacement"
    | "agentCorrectionDisplacement"
    | "wallCorrectionDisplacement"
  >
>;

function stepDiagnostic(
  stepIndex: number,
  time: number,
  before: AgentState,
  after: AgentState,
  targetVelocity: Vec2,
  overrides: DiagnosticOverrides = {},
): StepDiagnostics {
  const agentCorrection = overrides.agentCorrectionDisplacement ?? 0;
  const wallCorrection = overrides.wallCorrectionDisplacement ?? 0;
  return {
    stepIndex,
    time,
    preCorrectionOverlapPairs: overrides.preCorrectionOverlapPairs ?? 0,
    postCorrectionOverlapPairs: overrides.postCorrectionOverlapPairs ?? 0,
    preCorrectionWallContacts: 0,
    postCorrectionWallContacts: 0,
    maxPreCorrectionPenetration: overrides.maxPreCorrectionPenetration ?? 0,
    maxPostCorrectionPenetration: overrides.maxPostCorrectionPenetration ?? 0,
    maxPreCorrectionWallPenetration: 0,
    maxPostCorrectionWallPenetration: 0,
    totalPreCorrectionOverlapPenetration: 0,
    totalPostCorrectionOverlapPenetration: 0,
    totalPreCorrectionWallPenetration: 0,
    totalPostCorrectionWallPenetration: 0,
    minimumPreCorrectionClearance: overrides.minimumPreCorrectionClearance ?? null,
    correctedAgentPairs: 0,
    correctedWallContacts: 0,
    intendedDisplacement: overrides.intendedDisplacement ?? 0,
    agentCorrectionDisplacement: agentCorrection,
    wallCorrectionDisplacement: wallCorrection,
    totalCorrectionDisplacement: agentCorrection + wallCorrection,
    correctionRatio: 0,
    coincidentNeighborContributionsSkipped: 0,
    perAgent: [
      {
        id: before.id,
        targetVelocity,
        smoothedVelocity: after.velocity,
        realizedVelocity: after.velocity,
        preCorrectionPosition: after.position,
        postCorrectionPosition: after.position,
        agentCorrectionDisplacement: agentCorrection,
        wallCorrectionDisplacement: wallCorrection,
      },
    ],
  };
}

function twoAgentDiagnostic(
  stepIndex: number,
  time: number,
  first: AgentState,
  second: AgentState,
  firstTarget: Vec2,
  secondTarget: Vec2,
): StepDiagnostics {
  const base = stepDiagnostic(stepIndex, time, first, first, firstTarget, {
    minimumPreCorrectionClearance: 3.4,
  });
  return {
    ...base,
    perAgent: [
      base.perAgent[0],
      {
        id: second.id,
        targetVelocity: secondTarget,
        smoothedVelocity: second.velocity,
        realizedVelocity: second.velocity,
        preCorrectionPosition: second.position,
        postCorrectionPosition: second.position,
        agentCorrectionDisplacement: 0,
        wallCorrectionDisplacement: 0,
      },
    ],
  };
}
