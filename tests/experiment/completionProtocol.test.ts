import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createJuPedSimInput } from "../../experiments/engines/JuPedSimSfmEngine";
import { ScientificCoreEngine } from "../../experiments/engines/ScientificCoreEngine";
import { serializeOrcaInput } from "../../experiments/engines/OrcaRvo2Engine";
import type { EngineAgentStep, EngineStepRecord } from "../../experiments/engines/engineStep";
import { generateBidirectionalScenario } from "../../experiments/generation/bidirectional";
import { generateBottleneckScenario } from "../../experiments/generation/bottleneck";
import { generateCircleAntipodalScenario } from "../../experiments/generation/circleAntipodal";
import { createScenario, makeAgent } from "../../experiments/generation/common";
import { generatePairwiseScenario } from "../../experiments/generation/pairwise";
import { RunMetricsAccumulator } from "../../experiments/metrics/RunMetricsAccumulator";
import {
  directionalLineCrossingFraction,
  firstSegmentDiskIntersectionFraction,
  protocolNavigationRunnerConfig,
  resolveProtocolTarget,
} from "../../experiments/protocol/completion";
import { identifyMethod } from "../../experiments/protocol/methodIdentity";
import {
  parseMethodConfig,
  type JuPedSimSfmMethodConfig,
  type MethodConfig,
  type OrcaMethodConfig,
} from "../../experiments/protocol/methodConfig";
import type { ExperimentScenario } from "../../experiments/protocol/schema";
import type { AgentState, Vec2 } from "../../src/core/types";

const methodMetadata = {
  methodId: "completion-test",
  methodKey: "completion-test--000000000000",
  methodConfigSha256: "0".repeat(64),
  velocityTimeConstant: 0,
  methodParameters: {},
} as const;

describe("paper-facing completion protocol v2", () => {
  it("detects goal-disk completion from the realized post-correction segment", () => {
    const scenario = singleAgentScenario();
    const metrics = observe(scenario, [step(scenario, 0, [[0, 0]], [[0.5, 0]], [[1.2, 0]])]);
    expect(metrics.completion.completedAgents).toBe(1);
    expect(metrics.completion.perAgent[0].firstCompletionTime).toBeCloseTo(0.75, 14);
  });

  it("counts a goal-disk crossing even when the realized endpoint is outside", () => {
    const scenario = singleAgentScenario();
    const metrics = observe(scenario, [step(scenario, 0, [[0, 0]], [[1.2, 0]], [[1.2, 0]])]);
    expect(metrics.completion.successFraction).toBe(1);
    expect(metrics.completion.perAgent[0].finalDistanceToPointGoal).toBeCloseTo(0.2, 15);
    expect(metrics.completion.legacyFinalPointGoalArrivedFraction).toBe(0);
  });

  it("accepts a serialized float32 endpoint on the analytic goal boundary", () => {
    expect(firstSegmentDiskIntersectionFraction(
      [4, 0],
      [4.89999972, 0],
      [5, 0],
      0.1,
    )).toBe(1);
  });

  it("does not recount a serialized boundary point as repeated goal entries", () => {
    const scenario = singleAgentScenario();
    const boundary: Vec2 = [0.89999982, 0];
    const metrics = observe(scenario, [
      step(scenario, 0, [[0, 0]], [boundary], [boundary]),
      step(scenario, 1, [boundary], [boundary], [boundary]),
    ]);
    expect(metrics.completion.completedAgents).toBe(1);
    expect(metrics.completion.postCorrectionGoalDiskEntries).toBe(1);
  });

  it("does not turn a pre-correction-only goal entry into completion", () => {
    const scenario = singleAgentScenario();
    const metrics = observe(scenario, [step(scenario, 0, [[0, 0]], [[1, 0]], [[0.5, 0]])]);
    expect(metrics.completion.successFraction).toBe(0);
    expect(metrics.completion.preCorrectionGoalDiskEntries).toBe(1);
    expect(metrics.completion.postCorrectionGoalDiskEntries).toBe(0);
    expect(metrics.completion.correctionEjectedGoalDiskEntries).toBe(1);
  });

  it("keeps completion irreversible after later movement and recrossing", () => {
    const scenario = directionalScenario();
    const metrics = observe(scenario, [
      step(scenario, 0, [[0, 0]], [[2, 0]], [[2, 0]]),
      step(scenario, 1, [[2, 0]], [[0, 0]], [[0, 0]]),
    ]);
    expect(metrics.completion.completedAgents).toBe(1);
    expect(metrics.completion.perAgent[0].firstCompletionTime).toBe(0.5);
  });

  it("requires the specified line-crossing direction and rejects touching", () => {
    const positive = { type: "directional_line", axis: "x", threshold: 1, direction: "positive" } as const;
    expect(directionalLineCrossingFraction([0, 0], [2, 0], positive)).toBe(0.5);
    expect(directionalLineCrossingFraction([2, 0], [0, 0], positive)).toBeNull();
    expect(directionalLineCrossingFraction([0, 0], [1, 0], positive)).toBeNull();
    expect(directionalLineCrossingFraction([1, 0], [2, 0], positive)).toBeNull();
  });

  it("gives head-on and perpendicular crossing thirty-second horizons", () => {
    expect(generatePairwiseScenario("head_on", "test", 400).simulation.horizonSeconds).toBe(30);
    expect(generatePairwiseScenario("crossing", "test", 400).simulation.horizonSeconds).toBe(30);
  });

  it("lets both pairwise agents complete independently", () => {
    const agents = [
      makeAgent(0, [0, 0], [1, 0], 1),
      makeAgent(1, [0, 1], [-1, 1], 1),
    ];
    const scenario = createScenario(
      { family: "pairwise", variant: "fixture", split: "test", seed: 0 },
      2,
      agents,
    );
    scenario.simulation.dt = 1;
    const metrics = observe(scenario, [
      step(scenario, 0, [[0, 0], [0, 1]], [[1, 0], [-0.2, 1]], [[1, 0], [-0.2, 1]]),
      step(scenario, 1, [[1, 0], [-0.2, 1]], [[1, 0], [-1, 1]], [[1, 0], [-1, 1]]),
    ]);
    expect(metrics.completion.completedAgents).toBe(2);
    expect(metrics.completion.perAgent[0].firstCompletionTime).toBeCloseTo(0.9, 14);
    expect(metrics.completion.perAgent[1].firstCompletionTime).toBeCloseTo(1.875, 14);
  });

  it("assigns corridor agents to the correct directional exit lines", () => {
    const scenario = generateBidirectionalScenario("test", 400, 4);
    expect(scenario.completion.rule.type).toBe("per_agent_directional_line");
    if (scenario.completion.rule.type !== "per_agent_directional_line") return;
    for (const rule of scenario.completion.rule.rules) {
      const agent = scenario.agents.find(({ id }) => id === rule.agentId) as AgentState;
      const rightMoving = agent.goal[0] > agent.position[0];
      expect(rule).toMatchObject({
        axis: "x",
        threshold: rightMoving ? 17 : -17,
        direction: rightMoving ? "positive" : "negative",
      });
    }
  });

  it("keeps corridor agents moving toward far goals after exit-line completion", () => {
    const scenario = generateBidirectionalScenario("test", 400, 4);
    const methodSource = JSON.stringify({
      methodConfigVersion: 1,
      id: "euclidean_goal_steering_v1",
      velocityTimeConstant: 0.04,
      parameters: {},
    });
    const method = parseMethodConfig(JSON.parse(methodSource) as unknown);
    const identity = identifyMethod(method, methodSource);
    const records: EngineStepRecord[] = [];
    new ScientificCoreEngine(method.id, identity.methodKey)
      .run(scenario, method, identity, (record) => records.push(record));
    const firstAgent = scenario.agents[0];
    const crossingIndex = records.findIndex((record) =>
      record.agents.find(({ id }) => id === firstAgent.id)?.postCorrectionPosition[0] as number > 17);
    expect(crossingIndex).toBeGreaterThanOrEqual(0);
    const atCrossing = records[crossingIndex].agents.find(({ id }) => id === firstAgent.id) as EngineAgentStep;
    const later = records[Math.min(records.length - 1, crossingIndex + 10)]
      .agents.find(({ id }) => id === firstAgent.id) as EngineAgentStep;
    expect(later.postCorrectionPosition[0]).toBeGreaterThan(atCrossing.postCorrectionPosition[0]);
    expect(Math.hypot(...later.realizedVelocity)).toBeGreaterThan(0);
  });

  it("uses compatible uncompressed bottleneck goals inside the closed chamber", () => {
    const scenario = generateBottleneckScenario("test", 400, 112);
    for (const agent of scenario.agents) {
      expect(agent.goal[0]).toBe(10);
      expect(agent.goal[1]).toBe(agent.position[1]);
      expect(agent.goal[1]).toBeGreaterThan(-5.95);
      expect(agent.goal[1]).toBeLessThan(5.95);
    }
    expect(scenario.walls).toEqual(expect.arrayContaining([
      { id: 0, start: [-14, -6], end: [12, -6], thickness: 0.1 },
      { id: 1, start: [-14, 6], end: [12, 6], thickness: 0.1 },
      { id: 2, start: [-14, -6], end: [-14, 6], thickness: 0.1 },
      { id: 3, start: [12, -6], end: [12, 6], thickness: 0.1 },
    ]));
  });

  it("places bottleneck completion downstream of the opening", () => {
    const scenario = generateBottleneckScenario("test", 400, 16);
    expect(scenario.completion.rule).toEqual({
      type: "directional_line", axis: "x", threshold: 8, direction: "positive",
    });
    if (scenario.completion.rule.type !== "directional_line") return;
    expect(directionalLineCrossingFraction([-1, 0], [2, 0], scenario.completion.rule)).toBeNull();
  });

  it("feeds every adapter the same deterministic bottleneck navigation configuration", () => {
    const scenario = generateBottleneckScenario("test", 400, 16);
    const study = JSON.parse(readFileSync("experiments/lean/study.json", "utf8")) as {
      methods: Record<string, unknown>;
    };
    const goal = parseMethodConfig(study.methods.goal) as MethodConfig;
    const orca = parseMethodConfig(study.methods.orca) as OrcaMethodConfig;
    const jupedsim = parseMethodConfig(study.methods["jupedsim-sfm"]) as JuPedSimSfmMethodConfig;
    const expected = protocolNavigationRunnerConfig(scenario);
    expect(createJuPedSimInput(scenario, jupedsim).navigation).toEqual(expected);
    expect(serializeOrcaInput(scenario, orca)).toContain(
      "NAVIGATION WAYPOINT_THEN_POINT_GOAL 1.5 0 x 1 positive",
    );
    const identity = identifyMethod(goal, JSON.stringify(study.methods.goal));
    let firstRecord: EngineStepRecord | undefined;
    new ScientificCoreEngine(goal.id, identity.methodKey)
      .run({ ...scenario, simulation: { ...scenario.simulation, horizonSeconds: scenario.simulation.dt } }, goal, identity,
        (record) => { firstRecord = record; });
    expect(firstRecord?.agents.every(({ navigationTarget }) =>
      navigationTarget[0] === 1.5 && navigationTarget[1] === 0)).toBe(true);
    const positions: Vec2[] = [[-1, 0.5], [0.5, 0.2], [1.1, 0.1], [2, 0]];
    expect(positions.map((position) => resolveProtocolTarget(scenario, {
      position,
      goal: [10, 2],
    }))).toEqual([[1.5, 0], [1.5, 0], [10, 2], [10, 2]]);
  });

  it("preserves circle antipodal point goals and goal-disk completion semantics", () => {
    const scenario = generateCircleAntipodalScenario("test", 400, 50);
    expect(scenario.completion.rule).toEqual({ type: "goal_disk" });
    expect(scenario.navigation).toEqual({ type: "point_goal" });
    for (const agent of scenario.agents) {
      expect(agent.goal[0]).toBeCloseTo(-agent.position[0], 14);
      expect(agent.goal[1]).toBeCloseTo(-agent.position[1], 14);
    }
  });

  it("keeps legacy point-goal diagnostics separate from line completion", () => {
    const scenario = directionalScenario();
    const metrics = observe(scenario, [step(scenario, 0, [[0, 0]], [[2, 0]], [[2, 0]])]);
    expect(metrics.completion.successFraction).toBe(1);
    expect(metrics.completion.legacyPointGoalSuccessFraction).toBe(0);
    expect(metrics.completion.perAgent[0].legacyFirstPointGoalArrivalTime).toBeNull();
    expect(metrics.completion.perAgent[0].minimumDistanceToPointGoal).toBe(3);
    expect(metrics.completion.perAgent[0].finalDistanceToPointGoal).toBe(3);
  });

  it("does not change safety, acceleration, jerk, path, or correction metrics", () => {
    const goalDisk = singleAgentScenario();
    const directional = directionalScenario();
    const record = step(goalDisk, 0, [[0, 0]], [[0.8, 0]], [[0.7, 0]], {
      maximumPreCorrectionAgentPenetration: 0.2,
      maximumPostCorrectionAgentPenetration: 0.1,
      agentCorrectionDisplacement: 0.1,
    });
    const first = observe(goalDisk, [record]);
    const second = observe(directional, [{
      ...record,
      agents: record.agents.map((agent) => ({ ...agent, navigationTarget: [5, 0] })),
    }]);
    expect(second.separation).toEqual(first.separation);
    expect(second.correctionDependence).toEqual(first.correctionDependence);
    expect(second.smoothness).toEqual(first.smoothness);
    expect(second.pathEfficiency).toEqual(first.pathEfficiency);
  });
});

function singleAgentScenario(): ExperimentScenario {
  const scenario = createScenario(
    { family: "free_space", variant: "fixture", split: "test", seed: 0 },
    2,
    [makeAgent(0, [0, 0], [1, 0], 1)],
  );
  scenario.simulation.dt = 1;
  scenario.simulation.goalTolerance = 0.1;
  scenario.completion.idealCompletionDistances[0].idealCompletionDistance = 0.9;
  return scenario;
}

function directionalScenario(): ExperimentScenario {
  const scenario = createScenario(
    { family: "free_space", variant: "directional_fixture", split: "test", seed: 0 },
    2,
    [makeAgent(0, [0, 0], [5, 0], 1)],
  );
  scenario.simulation.dt = 1;
  scenario.completion = {
    completionSpecVersion: 1,
    rule: { type: "directional_line", axis: "x", threshold: 1, direction: "positive" },
    idealCompletionDistances: [{ agentId: 0, idealCompletionDistance: 1 }],
  };
  return scenario;
}

function observe(scenario: ExperimentScenario, records: readonly EngineStepRecord[]) {
  const accumulator = new RunMetricsAccumulator(scenario, methodMetadata);
  records.forEach((record) => accumulator.observeStep(record));
  const last = records.at(-1);
  const finalStates = scenario.agents.map((agent, index) => ({
    ...agent,
    position: last?.agents[index].postCorrectionPosition ?? agent.position,
    velocity: last?.agents[index].realizedVelocity ?? agent.velocity,
    arrived: false,
  }));
  return accumulator.finish(finalStates);
}

function step(
  scenario: ExperimentScenario,
  stepIndex: number,
  before: readonly Vec2[],
  pre: readonly Vec2[],
  post: readonly Vec2[],
  overrides: Partial<EngineStepRecord["diagnostics"]> = {},
): EngineStepRecord {
  const agents = scenario.agents.map((definition, index): EngineAgentStep => ({
    id: definition.id,
    positionBefore: before[index],
    velocityBefore: [0, 0],
    preCorrectionPosition: pre[index],
    postCorrectionPosition: post[index],
    navigationTarget: resolveProtocolTarget(scenario, { ...definition, position: before[index] }),
    commandVelocity: [post[index][0] - before[index][0], post[index][1] - before[index][1]],
    realizedVelocity: [post[index][0] - before[index][0], post[index][1] - before[index][1]],
    arrived: false,
  }));
  const intendedDisplacement = agents.reduce((sum, agent) => sum + Math.hypot(
    agent.preCorrectionPosition[0] - agent.positionBefore[0],
    agent.preCorrectionPosition[1] - agent.positionBefore[1],
  ), 0);
  return {
    engineStepVersion: 2,
    stepIndex,
    time: stepIndex + 1,
    agents,
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
      intendedDisplacement,
      agentCorrectionDisplacement: 0,
      wallCorrectionDisplacement: 0,
      correctionMode: "shared_projection",
      ...overrides,
      totalCorrectionDisplacement:
        (overrides.agentCorrectionDisplacement ?? 0) + (overrides.wallCorrectionDisplacement ?? 0),
    },
  };
}
