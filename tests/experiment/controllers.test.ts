import { describe, expect, it } from "vitest";
import { controllerLabel, createMotionController } from "../../src/core/controllerFactory";
import { EuclideanGoalController } from "../../src/core/EuclideanGoalController";
import { RiemannianController } from "../../src/core/RiemannianController";
import { SimulatorCore, type SimulatorCoreOptions } from "../../src/core/SimulatorCore";
import {
  CONTROLLER_ID,
  EUCLIDEAN_GOAL_CONTROLLER_ID,
  type AgentState,
  type ScientificControllerParameters,
  type Vec2,
} from "../../src/core/types";

const riemannianParameters = {
  id: CONTROLLER_ID,
  alpha: 10,
  sigma: 2.4,
  lambdaR: 10,
  lambdaT: 1,
} as const;

describe("scientific controller abstraction", () => {
  it("selects stable controller IDs and labels centrally", () => {
    expect(createMotionController(riemannianParameters).id).toBe(CONTROLLER_ID);
    expect(createMotionController({ id: EUCLIDEAN_GOAL_CONTROLLER_ID }).id).toBe(
      EUCLIDEAN_GOAL_CONTROLLER_ID,
    );
    expect(controllerLabel(CONTROLLER_ID)).toBe("Conditioned Riemannian");
    expect(controllerLabel(EUCLIDEAN_GOAL_CONTROLLER_ID)).toBe("Goal+Projection");
  });

  it("rejects unsupported controller IDs", () => {
    expect(() =>
      createMotionController({ id: "unsupported" } as unknown as ScientificControllerParameters),
    ).toThrow(/Unsupported controller id/u);
    expect(() => controllerLabel("unsupported")).toThrow(/Unsupported controller id/u);
  });

  it("preserves the Stage A Riemannian calculation exactly", () => {
    const controlled = agent(0, [0, 0], [1, 0], [8, 0.5], 1.4);
    const neighbors = [
      agent(2, [1.1, 0.2], [-1, 0], [-8, 0.2], 1.3),
      agent(1, [0.8, -0.4], [-0.5, 0.1], [-8, -0.4], 1.5),
    ];
    const controller = new RiemannianController(riemannianParameters);
    const effective = controller.computeEffectiveMetric(controlled, neighbors);
    const legacy = controller.computeTargetVelocity(controlled, effective.metric, 0.1);
    expect(controller.computeControl(controlled, neighbors, 0.1)).toEqual({
      ...legacy,
      coincidentNeighborContributionsSkipped: effective.coincidentNeighborContributionsSkipped,
    });
  });

  it("keeps Euclidean simulation output invariant to agent input order", () => {
    const options = euclideanOptions();
    const reversed = { ...options, agents: [...options.agents].reverse() };
    const first = new SimulatorCore(options);
    const second = new SimulatorCore(reversed);
    expect(first.step()).toEqual(second.step());
    expect(first.getAgents()).toEqual(second.getAgents());
    expect(first.getAgents().map(({ id }) => id)).toEqual([0, 1]);
  });
});

describe("Euclidean goal steering", () => {
  const controller = new EuclideanGoalController();

  it("points exactly toward the goal at preferred Euclidean speed", () => {
    const result = controller.computeControl(agent(0, [1, 2], [4, 0], [4, 6], 1.5), [], 0.01);
    expect(result.targetVelocity[0]).toBeCloseTo(0.9, 15);
    expect(result.targetVelocity[1]).toBeCloseTo(1.2, 15);
    expect(Math.hypot(...result.targetVelocity)).toBeCloseTo(1.5, 15);
    expect(result.arrived).toBe(false);
  });

  it("ignores neighbors completely", () => {
    const controlled = agent(0, [0, 0], [0, 0], [10, 0], 1.4);
    const withoutNeighbors = controller.computeControl(controlled, [], 0.01);
    const withNeighbors = controller.computeControl(
      controlled,
      [agent(1, [0.1, 0], [-20, 4], [-10, 0], 3)],
      0.01,
    );
    expect(withNeighbors).toEqual(withoutNeighbors);
    expect(controller.interactionRadius).toBe(0);
  });

  it("has no lateral bias and returns zero inside the goal disk", () => {
    expect(controller.computeControl(agent(0, [0, 0], [0, 4], [10, 0]), [], 0.01).targetVelocity).toEqual([
      1,
      0,
    ]);
    expect(controller.computeControl(agent(0, [0.05, 0], [3, 2], [0, 0]), [], 0.1)).toEqual({
      targetVelocity: [0, 0],
      arrived: true,
      coincidentNeighborContributionsSkipped: 0,
    });
  });

  it("uses the shared time smoothing and correction layers", () => {
    const options = euclideanOptions();
    const simulator = new SimulatorCore(options);
    const diagnostic = simulator.step();
    const eta = Math.exp(-options.simulation.dt / options.simulation.velocityTimeConstant);
    expect(diagnostic.perAgent[0].smoothedVelocity[0]).toBeCloseTo(
      eta * options.agents[0].velocity[0] + (1 - eta) * diagnostic.perAgent[0].targetVelocity[0],
      15,
    );
    expect(diagnostic.correctedAgentPairs).toBeGreaterThan(0);
    expect(diagnostic.agentCorrectionDisplacement).toBeGreaterThan(0);
  });
});

function euclideanOptions(): SimulatorCoreOptions {
  return {
    agents: [
      agent(0, [-0.2, 0], [0, 0], [5, 0], 1),
      agent(1, [0.2, 0], [0, 0], [-5, 0], 1),
    ],
    walls: [],
    simulation: {
      dt: 0.1,
      goalTolerance: 0.05,
      velocityTimeConstant: 0.2,
      correction: { enabled: true, iterations: 2, padding: 0.001 },
    },
    controller: { id: EUCLIDEAN_GOAL_CONTROLLER_ID },
  };
}

function agent(
  id: number,
  position: Vec2,
  velocity: Vec2,
  goal: Vec2,
  preferredSpeed = 1,
): AgentState {
  return { id, position, velocity, goal, preferredSpeed, radius: 0.3, arrived: false };
}
