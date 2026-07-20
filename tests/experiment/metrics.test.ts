import { describe, expect, it } from "vitest";
import { constantVelocityTimeToContact } from "../../experiments/metrics/geometry";
import {
  PAIRWISE_AVOIDANCE_THRESHOLD_DEGREES,
  RunMetricsAccumulator,
} from "../../experiments/metrics/RunMetricsAccumulator";
import type { EngineStepRecord } from "../../experiments/engines/engineStep";
import type { ExperimentScenario } from "../../experiments/protocol/schema";
import type { AgentState, StepDiagnostics, Vec2 } from "../../src/core/types";

const methodMetadata = {
  methodId: "analytical",
  methodKey: "analytical--000000000000",
  methodConfigSha256: "0".repeat(64),
  velocityTimeConstant: 0,
  methodParameters: {},
} as const;

describe("online common metrics", () => {
  it("computes analytical arrival, travel, path, exposure, correction, smoothness, and throughput", () => {
    const initial = agent(0, [0, 0], [0, 0], [1, 0], false);
    const scenario = scenarioOf([initial], "free_space", 1);
    const after = agent(0, [1, 0], [1, 0], [1, 0], true);
    const diagnostic = stepDiagnostic(0, 1, initial, after, [1, 0], {
      preCorrectionOverlapPairs: 2,
      postCorrectionOverlapPairs: 1,
      maximumPreCorrectionAgentPenetration: 0.2,
      maximumPostCorrectionAgentPenetration: 0.05,
      maximumPreCorrectionWallPenetration: 0.3,
      maximumPostCorrectionWallPenetration: 0.1,
      minimumPreCorrectionAgentClearance: -0.2,
      minimumPreCorrectionWallClearance: -0.3,
      intendedDisplacement: 1,
      agentCorrectionDisplacement: 0.25,
      wallCorrectionDisplacement: 0.25,
    });
    const accumulator = new RunMetricsAccumulator(scenario, methodMetadata);
    accumulator.observeStep([initial], diagnostic, [after]);
    const metrics = accumulator.finish([after]);

    expect(metrics.completion.completedAgents).toBe(1);
    const outcome = metrics.completion.perAgent[0];
    expect(outcome).toMatchObject({
      id: 0,
      completionType: "goal_disk",
      idealCompletionDistance: 0.99,
      minimumDistanceToPointGoal: 0,
      finalDistanceToPointGoal: 0,
      pathEfficiency: 1,
    });
    expect(outcome.firstCompletionTime).toBeCloseTo(0.99, 14);
    expect(outcome.normalizedCompletionTime).toBeCloseTo(1, 14);
    expect(outcome.legacyFirstPointGoalArrivalTime).toBeCloseTo(0.99, 14);
    expect(metrics.completionTime.meanNormalizedCompletionTime).toBeCloseTo(1, 14);
    expect(metrics.pathEfficiency.meanPathEfficiency).toBe(1);
    expect(metrics.separation.totalPreCorrectionOverlapPairSeconds).toBe(2);
    expect(metrics.separation.totalPostCorrectionOverlapPairSeconds).toBe(1);
    expect(metrics.separation.preCorrectionOverlapPairSecondsPerAgentSecond).toBe(2);
    expect(metrics.separation.minimumPreCorrectionAgentClearance).toBe(-0.2);
    expect(metrics.separation.minimumPreCorrectionWallClearance).toBe(-0.3);
    expect(metrics.separation.maximumPreCorrectionAgentPenetration).toBe(0.2);
    expect(metrics.separation.maximumPreCorrectionWallPenetration).toBe(0.3);
    expect(metrics.separation.maximumPostCorrectionAgentPenetration).toBe(0.05);
    expect(metrics.separation.maximumPostCorrectionWallPenetration).toBe(0.1);
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
    const accumulator = new RunMetricsAccumulator(
      scenarioOf([initial], "free_space", 1),
      methodMetadata,
    );
    accumulator.observeStep([initial], stepDiagnostic(0, 1, initial, first, [1, 0]), [first]);
    accumulator.observeStep([first], stepDiagnostic(1, 2, first, second, [3, 0]), [second]);
    const metrics = accumulator.finish([second]);
    expect(metrics.smoothness.accelerationSampleCount).toBe(2);
    expect(metrics.smoothness.jerkSampleCount).toBe(1);
    expect(metrics.smoothness.rmsAcceleration).toBeCloseTo(Math.sqrt(2.5), 15);
    expect(metrics.smoothness.rmsJerk).toBe(1);
    expect(metrics.completion.successFraction).toBe(0);
    expect(metrics.completionTime.meanNormalizedCompletionTime).toBeNull();
    expect(metrics.pathEfficiency.meanPathEfficiency).toBeNull();
  });

  it("excludes all samples after first arrival without latching simulator state", () => {
    const initial = agent(0, [0, 0], [0, 0], [1, 0], false);
    const arrived = agent(0, [1, 0], [1, 0], [1, 0], true);
    const later = agent(0, [2, 0], [100, 0], [1, 0], false);
    const accumulator = new RunMetricsAccumulator(
      scenarioOf([initial], "free_space", 1),
      methodMetadata,
    );
    accumulator.observeStep([initial], stepDiagnostic(0, 1, initial, arrived, [1, 0]), [arrived]);
    accumulator.observeStep([arrived], stepDiagnostic(1, 2, arrived, later, [100, 0]), [later]);
    const metrics = accumulator.finish([later]);
    expect(metrics.completion.perAgent[0].legacyFirstPointGoalArrivalTime).toBeCloseTo(0.99, 14);
    expect(metrics.completion.legacyFinalPointGoalArrivedFraction).toBe(0);
    expect(metrics.smoothness.accelerationSampleCount).toBe(1);
  });

  it("uses explicit nulls for zero-duration and unavailable metrics", () => {
    const initial = agent(0, [0, 0], [0, 0], [10, 0], false);
    const metrics = new RunMetricsAccumulator(
      scenarioOf([initial], "free_space", 1),
      methodMetadata,
    ).finish([initial]);
    expect(metrics.identity.simulatedDuration).toBe(0);
    expect(metrics.throughput).toBeNull();
    expect(metrics.smoothness.rmsAcceleration).toBeNull();
    expect(metrics.smoothness.rmsJerk).toBeNull();
    expect(metrics.separation.preCorrectionOverlapPairSecondsPerAgentSecond).toBeNull();
    expect(metrics.completion.perAgent[0].firstCompletionTime).toBeNull();
    expect(JSON.stringify(metrics)).not.toMatch(/NaN|Infinity/u);
  });

  it("counts a stationary precision-mapped native step as exactly zero realized path", () => {
    const initial = agent(0, [0.002, 0], [0, 0], [0, 0], false);
    const mappedPosition: Vec2 = [0.00199999996, 0];
    const final = agent(0, mappedPosition, [0, 0], [0, 0], true);
    const accumulator = new RunMetricsAccumulator(
      scenarioOf([initial], "free_space", 1),
      methodMetadata,
    );
    accumulator.observeStep(engineStep(mappedPosition, mappedPosition, [0, 0], true));
    const metrics = accumulator.finish([final]);

    expect(metrics.completion.perAgent[0].pathEfficiency).toBe(0);
    expect(metrics.pathEfficiency.meanPathEfficiency).toBe(0);
    expect(metrics.smoothness.rmsAcceleration).toBeNull();
  });

  it("counts real native motion independently of scenario-to-engine representation mapping", () => {
    const initial = agent(0, [0.02, 0], [0, 0], [1.02, 0], false);
    const mappedPosition: Vec2 = [0.0199999996, 0];
    const finalPosition: Vec2 = [1.0199999996, 0];
    const final = agent(0, finalPosition, [1, 0], [1.02, 0], true);
    const accumulator = new RunMetricsAccumulator(
      scenarioOf([initial], "free_space", 1),
      methodMetadata,
    );
    accumulator.observeStep(engineStep(mappedPosition, finalPosition, [1, 0], true));

    expect(accumulator.finish([final]).completion.perAgent[0].pathEfficiency).toBeCloseTo(1, 15);
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
    const accumulator = new RunMetricsAccumulator(scenario, methodMetadata);
    accumulator.observeStep([first, second], diagnostic, [first, second]);
    const pairwise = accumulator.finish([first, second]).pairwise;
    expect(PAIRWISE_AVOIDANCE_THRESHOLD_DEGREES).toBe(5);
    expect(pairwise?.perAgent[0].avoidanceOnsetTime).toBe(0);
    expect(pairwise?.perAgent[0].ttcAtAvoidanceOnset).toBeCloseTo(1.7, 15);
    expect(pairwise?.perAgent[1].avoidanceOnsetTime).toBeNull();
    expect(pairwise?.minimumPreCorrectionCenterDistance).toBe(4);
    expect(pairwise?.minimumPreCorrectionPhysicalClearance).toBeCloseTo(3.4, 15);
    expect(pairwise?.minimumPostCorrectionCenterDistance).toBe(4);
    expect(pairwise?.minimumPostCorrectionPhysicalClearance).toBeCloseTo(3.4, 15);
  });

  it("does not declare onset for zero target or deflection below the threshold", () => {
    const first = agent(0, [-2, 0], [1, 0], [2, 0], false);
    const second = agent(1, [2, 0], [-1, 0], [-2, 0], false);
    const angle = (4 * Math.PI) / 180;
    const accumulator = new RunMetricsAccumulator(
      scenarioOf([first, second], "pairwise", 1),
      methodMetadata,
    );
    accumulator.observeStep(
      [first, second],
      twoAgentDiagnostic(0, 1, first, second, [Math.cos(angle), Math.sin(angle)], [0, 0]),
      [first, second],
    );
    const pairwise = accumulator.finish([first, second]).pairwise;
    expect(pairwise?.perAgent.every(({ avoidanceOnsetTime }) => avoidanceOnsetTime === null)).toBe(true);
  });

  it("does not evaluate a new avoidance onset after an agent's first arrival", () => {
    const first = agent(0, [-2, 0], [1, 0], [-2, 0], true);
    const second = agent(1, [2, 0], [-1, 0], [-2, 0], false);
    const arrivedFirst = { ...first, arrived: true };
    const accumulator = new RunMetricsAccumulator(
      scenarioOf([first, second], "pairwise", 1),
      methodMetadata,
    );
    accumulator.observeStep(
      [first, second],
      twoAgentDiagnostic(0, 1, first, second, [1, 0], [-1, 0]),
      [arrivedFirst, second],
    );
    const deflected: Vec2 = [Math.cos(Math.PI / 30), Math.sin(Math.PI / 30)];
    accumulator.observeStep(
      [arrivedFirst, second],
      twoAgentDiagnostic(1, 2, arrivedFirst, second, deflected, [-1, 0]),
      [arrivedFirst, second],
    );
    const pairwise = accumulator.finish([arrivedFirst, second]).pairwise;
    expect(pairwise?.perAgent[0].avoidanceOnsetTime).toBeNull();
    expect(pairwise?.perAgent[1].avoidanceOnsetTime).toBeNull();
  });

  it("reports controller overlap before correction separately from corrected clearance", () => {
    const first = agent(0, [-0.2, 0], [1, 0], [2, 0], false);
    const second = agent(1, [0.2, 0], [-1, 0], [-2, 0], false);
    const diagnostic = twoAgentDiagnostic(0, 1, first, second, [1, 0], [-1, 0]);
    diagnostic.perAgent[0].preCorrectionPosition = [-0.1, 0];
    diagnostic.perAgent[1].preCorrectionPosition = [0.1, 0];
    diagnostic.perAgent[0].postCorrectionPosition = [-0.301, 0];
    diagnostic.perAgent[1].postCorrectionPosition = [0.301, 0];
    const accumulator = new RunMetricsAccumulator(
      scenarioOf([first, second], "pairwise", 1),
      methodMetadata,
    );
    accumulator.observeStep([first, second], diagnostic, [first, second]);
    const pairwise = accumulator.finish([first, second]).pairwise;
    expect(pairwise?.minimumPreCorrectionCenterDistance).toBeCloseTo(0.2, 15);
    expect(pairwise?.minimumPreCorrectionPhysicalClearance).toBeCloseTo(-0.4, 15);
    expect(pairwise?.minimumPostCorrectionCenterDistance).toBeCloseTo(0.602, 15);
    expect(pairwise?.minimumPostCorrectionPhysicalClearance).toBeCloseTo(0.002, 15);
  });
});

function scenarioOf(agents: AgentState[], family: string, dt: number): ExperimentScenario {
  return {
    experimentScenarioVersion: 2,
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
    completion: {
      completionSpecVersion: 1,
      rule: { type: "goal_disk" },
      idealCompletionDistances: agents.map((entry) => ({
        agentId: entry.id,
        idealCompletionDistance: Math.max(
          0,
          Math.hypot(entry.goal[0] - entry.position[0], entry.goal[1] - entry.position[1]) - 0.01,
        ),
      })),
    },
    navigation: { type: "point_goal" },
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
    | "maximumPreCorrectionAgentPenetration"
    | "maximumPreCorrectionWallPenetration"
    | "maximumPostCorrectionAgentPenetration"
    | "maximumPostCorrectionWallPenetration"
    | "minimumPreCorrectionAgentClearance"
    | "minimumPreCorrectionWallClearance"
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
  const maximumPreCorrectionAgentPenetration =
    overrides.maximumPreCorrectionAgentPenetration ?? 0;
  const maximumPreCorrectionWallPenetration =
    overrides.maximumPreCorrectionWallPenetration ?? 0;
  const maximumPostCorrectionAgentPenetration =
    overrides.maximumPostCorrectionAgentPenetration ?? 0;
  const maximumPostCorrectionWallPenetration =
    overrides.maximumPostCorrectionWallPenetration ?? 0;
  const minimumPreCorrectionAgentClearance =
    overrides.minimumPreCorrectionAgentClearance ?? null;
  const minimumPreCorrectionWallClearance =
    overrides.minimumPreCorrectionWallClearance ?? null;
  return {
    stepIndex,
    time,
    preCorrectionOverlapPairs: overrides.preCorrectionOverlapPairs ?? 0,
    postCorrectionOverlapPairs: overrides.postCorrectionOverlapPairs ?? 0,
    preCorrectionWallContacts: 0,
    postCorrectionWallContacts: 0,
    maxPreCorrectionPenetration: Math.max(
      maximumPreCorrectionAgentPenetration,
      maximumPreCorrectionWallPenetration,
    ),
    maxPostCorrectionPenetration: Math.max(
      maximumPostCorrectionAgentPenetration,
      maximumPostCorrectionWallPenetration,
    ),
    maxPreCorrectionWallPenetration: maximumPreCorrectionWallPenetration,
    maxPostCorrectionWallPenetration: maximumPostCorrectionWallPenetration,
    maximumPreCorrectionAgentPenetration,
    maximumPreCorrectionWallPenetration,
    maximumPostCorrectionAgentPenetration,
    maximumPostCorrectionWallPenetration,
    totalPreCorrectionOverlapPenetration: 0,
    totalPostCorrectionOverlapPenetration: 0,
    totalPreCorrectionWallPenetration: 0,
    totalPostCorrectionWallPenetration: 0,
    minimumPreCorrectionClearance:
      minimumPreCorrectionAgentClearance === null
        ? minimumPreCorrectionWallClearance
        : minimumPreCorrectionWallClearance === null
          ? minimumPreCorrectionAgentClearance
          : Math.min(minimumPreCorrectionAgentClearance, minimumPreCorrectionWallClearance),
    minimumPreCorrectionAgentClearance,
    minimumPreCorrectionWallClearance,
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
    minimumPreCorrectionAgentClearance: 3.4,
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

function engineStep(
  positionBefore: Vec2,
  positionAfter: Vec2,
  realizedVelocity: Vec2,
  arrived: boolean,
): EngineStepRecord {
  return {
    engineStepVersion: 2,
    stepIndex: 0,
    time: 1,
    agents: [{
      id: 0,
      positionBefore,
      velocityBefore: [0, 0],
      preCorrectionPosition: positionAfter,
      postCorrectionPosition: positionAfter,
      navigationTarget: [0, 0],
      commandVelocity: realizedVelocity,
      realizedVelocity,
      arrived,
    }],
    diagnostics: {
      preCorrectionOverlapPairs: 0,
      postCorrectionOverlapPairs: 0,
      preCorrectionWallContacts: 0,
      postCorrectionWallContacts: 0,
      minimumPreCorrectionAgentClearance: null,
      minimumPreCorrectionWallClearance: null,
      maximumPreCorrectionAgentPenetration: 0,
      maximumPostCorrectionAgentPenetration: 0,
      maximumPreCorrectionWallPenetration: 0,
      maximumPostCorrectionWallPenetration: 0,
      totalPreCorrectionAgentPenetration: 0,
      totalPostCorrectionAgentPenetration: 0,
      totalPreCorrectionWallPenetration: 0,
      totalPostCorrectionWallPenetration: 0,
      intendedDisplacement: Math.hypot(
        positionAfter[0] - positionBefore[0],
        positionAfter[1] - positionBefore[1],
      ),
      agentCorrectionDisplacement: 0,
      wallCorrectionDisplacement: 0,
      totalCorrectionDisplacement: 0,
      correctionMode: "native_none",
    },
  };
}
