import { describe, expect, it } from "vitest";
import { RiemannianController } from "../../src/core/RiemannianController";
import {
  correctionDisabled,
  SimulatorCore,
  smoothingCoefficient,
  type SimulatorCoreOptions,
} from "../../src/core/SimulatorCore";
import { CONTROLLER_ID, type AgentState } from "../../src/core/types";

describe("synchronous deterministic simulation", () => {
  it("computes all target velocities from the same old snapshot", () => {
    const options = pairOptions();
    const controller = new RiemannianController(options.controller);
    const expectedTargets = new Map(
      options.agents.map((agent) => {
        const metric = controller.computeEffectiveMetric(agent, options.agents).metric;
        return [agent.id, controller.computeTargetVelocity(agent, metric, options.simulation.goalTolerance).targetVelocity] as const;
      }),
    );
    const diagnostic = new SimulatorCore(options).step();
    for (const entry of diagnostic.perAgent) {
      expect(entry.targetVelocity).toEqual(expectedTargets.get(entry.id));
    }
  });

  it("is invariant to input permutation and returns ID-sorted output", () => {
    const options = pairOptions();
    const reversed: SimulatorCoreOptions = { ...options, agents: [...options.agents].reverse() };
    const first = new SimulatorCore(options);
    const second = new SimulatorCore(reversed);
    const firstDiagnostic = first.step();
    const secondDiagnostic = second.step();
    expect(firstDiagnostic).toEqual(secondDiagnostic);
    expect(first.getAgents()).toEqual(second.getAgents());
    expect(first.getAgents().map((agent) => agent.id)).toEqual([1, 9]);
  });

  it("uses exp(-dt/tau) smoothing", () => {
    const options = singleAgentOptions(0.1, 0.2);
    const diagnostic = new SimulatorCore(options).step();
    const eta = Math.exp(-0.1 / 0.2);
    expect(smoothingCoefficient(0.1, 0.2)).toBeCloseTo(eta, 15);
    expect(diagnostic.perAgent[0].targetVelocity).toEqual([1, 0]);
    expect(diagnostic.perAgent[0].smoothedVelocity[0]).toBeCloseTo(1 - eta, 15);
  });

  it("tracks the target immediately when tau is zero", () => {
    const diagnostic = new SimulatorCore(singleAgentOptions(0.1, 0)).step();
    expect(smoothingCoefficient(0.1, 0)).toBe(0);
    expect(diagnostic.perAgent[0].smoothedVelocity).toEqual(diagnostic.perAgent[0].targetVelocity);
  });

  it("leaves pre-correction positions unchanged when correction is disabled", () => {
    const diagnostic = new SimulatorCore(pairOptions(false)).step();
    for (const entry of diagnostic.perAgent) {
      expect(entry.postCorrectionPosition).toEqual(entry.preCorrectionPosition);
      expect(entry.agentCorrectionDisplacement).toBe(0);
      expect(entry.wallCorrectionDisplacement).toBe(0);
    }
    expect(diagnostic.totalCorrectionDisplacement).toBe(0);
  });

  it("defines realized velocity as final displacement divided by dt", () => {
    const options = pairOptions(true, true);
    const simulator = new SimulatorCore(options);
    const oldById = new Map(simulator.getAgents().map((agent) => [agent.id, agent.position]));
    const diagnostic = simulator.step();
    for (const entry of diagnostic.perAgent) {
      const old = oldById.get(entry.id)!;
      expect(entry.realizedVelocity[0]).toBeCloseTo((entry.postCorrectionPosition[0] - old[0]) / options.simulation.dt, 14);
      expect(entry.realizedVelocity[1]).toBeCloseTo((entry.postCorrectionPosition[1] - old[1]) / options.simulation.dt, 14);
    }
  });
});

function pairOptions(correctionEnabled = true, overlapping = false): SimulatorCoreOptions {
  const agents: AgentState[] = [
    {
      id: 9,
      position: overlapping ? [0.1, 0] : [1, 0.1],
      velocity: [-1, 0],
      goal: [-10, 0.1],
      radius: 0.3,
      preferredSpeed: 1,
      arrived: false,
    },
    {
      id: 1,
      position: overlapping ? [-0.1, 0] : [-1, -0.1],
      velocity: [1, 0],
      goal: [10, -0.1],
      radius: 0.3,
      preferredSpeed: 1,
      arrived: false,
    },
  ];
  return {
    agents,
    walls: [],
    simulation: {
      dt: 0.1,
      goalTolerance: 0.01,
      velocityTimeConstant: 0,
      correction: correctionEnabled
        ? { enabled: true, iterations: 2, padding: 0.001 }
        : correctionDisabled(),
    },
    controller: { id: CONTROLLER_ID, alpha: 10, sigma: 3, lambdaR: 10, lambdaT: 1 },
  };
}

function singleAgentOptions(dt: number, velocityTimeConstant: number): SimulatorCoreOptions {
  return {
    agents: [{
      id: 0,
      position: [0, 0],
      velocity: [0, 0],
      goal: [10, 0],
      radius: 0.3,
      preferredSpeed: 1,
      arrived: false,
    }],
    walls: [],
    simulation: { dt, goalTolerance: 0.01, velocityTimeConstant, correction: correctionDisabled() },
    controller: { id: CONTROLLER_ID, alpha: 0, sigma: 2, lambdaR: 2, lambdaT: 1 },
  };
}
