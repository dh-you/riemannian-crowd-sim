import { describe, expect, it } from "vitest";
import { firstSegmentDiskIntersection } from "../../src/core/math";
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

  it("holds an agent inside the goal tolerance despite residual velocity", () => {
    const options = singleAgentOptions(1, 0.5);
    options.agents = [{
      ...options.agents[0],
      position: [0.05, 0],
      velocity: [5, -2],
      goal: [0, 0],
    }];
    options.simulation.goalTolerance = 0.1;
    const simulator = new SimulatorCore(options);
    const diagnostic = simulator.step();
    const perAgent = diagnostic.perAgent[0];
    expect(perAgent.targetVelocity).toEqual([0, 0]);
    expect(perAgent.smoothedVelocity).toEqual([0, 0]);
    expect(perAgent.preCorrectionPosition).toEqual([0.05, 0]);
    expect(perAgent.postCorrectionPosition).toEqual([0.05, 0]);
    expect(perAgent.realizedVelocity).toEqual([0, 0]);
    expect(diagnostic.intendedDisplacement).toBe(0);
    expect(simulator.getAgents()[0].arrived).toBe(true);
  });

  it("recomputes arrival when correction pushes a held agent outside the goal disk", () => {
    const options = singleAgentOptions(0.5, 0.5);
    options.agents = [{
      ...options.agents[0],
      position: [0, 0],
      velocity: [4, 0],
      goal: [0, 0],
      radius: 0.1,
    }];
    options.walls = [{ id: 5, start: [-1, 0], end: [1, 0], thickness: 0 }];
    options.simulation.goalTolerance = 0.05;
    options.simulation.correction = { enabled: true, iterations: 1, padding: 0 };
    const simulator = new SimulatorCore(options);
    const diagnostic = simulator.step();
    const perAgent = diagnostic.perAgent[0];
    const finalState = simulator.getAgents()[0];
    expect(perAgent.targetVelocity).toEqual([0, 0]);
    expect(perAgent.smoothedVelocity).toEqual([0, 0]);
    expect(perAgent.preCorrectionPosition).toEqual([0, 0]);
    expect(perAgent.wallCorrectionDisplacement).toBeCloseTo(0.1, 15);
    expect(Math.hypot(...finalState.position)).toBeGreaterThan(options.simulation.goalTolerance);
    expect(finalState.arrived).toBe(false);
    expect(perAgent.realizedVelocity[0]).toBeCloseTo(perAgent.postCorrectionPosition[0] / 0.5, 15);
    expect(perAgent.realizedVelocity[1]).toBeCloseTo(perAgent.postCorrectionPosition[1] / 0.5, 15);
  });

  it("truncates an overshooting step at the first goal-disk intersection", () => {
    const options = singleAgentOptions(1, 0);
    options.agents = [{
      ...options.agents[0],
      position: [-2, 0],
      velocity: [0, 0],
      goal: [0, 0],
      preferredSpeed: 4,
    }];
    options.simulation.goalTolerance = 0.5;
    const simulator = new SimulatorCore(options);
    const diagnostic = simulator.step();
    const perAgent = diagnostic.perAgent[0];
    expect(perAgent.targetVelocity).toEqual([4, 0]);
    expect(perAgent.smoothedVelocity).toEqual([4, 0]);
    expect(perAgent.preCorrectionPosition).toEqual([-0.5, 0]);
    expect(perAgent.postCorrectionPosition).toEqual([-0.5, 0]);
    expect(perAgent.realizedVelocity).toEqual([1.5, 0]);
    expect(diagnostic.intendedDisplacement).toBe(1.5);
    expect(simulator.getAgents()[0].arrived).toBe(true);
    expect([...perAgent.preCorrectionPosition, ...perAgent.realizedVelocity].every(Number.isFinite)).toBe(true);
  });
});

describe("analytic segment-goal-disk intersection", () => {
  it("leaves a segment that misses the disk unchanged", () => {
    const end = [2, 2] as const;
    const intersection = firstSegmentDiskIntersection([-2, 2], end, [0, 0], 1);
    expect(intersection).toBeNull();
    expect(intersection ?? end).toEqual(end);
  });

  it("returns the deterministic tangent point", () => {
    expect(firstSegmentDiskIntersection([-2, 1], [2, 1], [0, 0], 1)).toEqual([0, 1]);
  });

  it("handles zero-length segments and starts already inside the disk", () => {
    expect(firstSegmentDiskIntersection([2, 0], [2, 0], [0, 0], 1)).toBeNull();
    expect(firstSegmentDiskIntersection([0.25, 0], [3, 0], [0, 0], 1)).toEqual([0.25, 0]);
    expect(firstSegmentDiskIntersection([0.25, 0], [0.25, 0], [0, 0], 1)).toEqual([0.25, 0]);
  });

  it("rejects non-finite geometry and negative radii", () => {
    expect(() => firstSegmentDiskIntersection([Number.NaN, 0], [1, 0], [0, 0], 1)).toThrow(/finite/u);
    expect(() => firstSegmentDiskIntersection([0, 0], [1, 0], [0, 0], -1)).toThrow(/nonnegative/u);
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
