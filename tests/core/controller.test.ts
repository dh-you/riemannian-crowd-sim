import { describe, expect, it } from "vitest";
import { identityMat2 } from "../../src/core/math";
import {
  closingGate,
  COINCIDENT_NEIGHBOR_EPSILON_METERS,
  RiemannianController,
  riemannianSpeed,
  visibilityGate,
} from "../../src/core/RiemannianController";
import { CONTROLLER_ID, type AgentState, type Vec2 } from "../../src/core/types";

const parameters = {
  id: CONTROLLER_ID,
  alpha: 10,
  sigma: 2.4,
  lambdaR: 10,
  lambdaT: 1,
};

describe("closing gate", () => {
  const radial = [1, 0] as const;
  const controlled = agent(0, [0, 0], [1, 0], [10, 0]);

  it("is zero for separating neighbors", () => {
    expect(closingGate(controlled, agent(1, [1, 0], [2, 0], [10, 0]), radial)).toBe(0);
  });

  it("is zero for co-moving neighbors", () => {
    expect(closingGate(controlled, agent(1, [1, 0], [1, 0], [10, 0]), radial)).toBe(0);
  });

  it("saturates for sufficiently approaching neighbors", () => {
    expect(closingGate(controlled, agent(1, [1, 0], [-1, 0], [-10, 0]), radial)).toBeCloseTo(1, 15);
  });
});

describe("visibility gate", () => {
  const controlled = agent(0, [0, 0], [-5, 0], [10, 0]);

  it("maps ahead, lateral, and behind to one, one half, and zero", () => {
    expect(visibilityGate(controlled, [1, 0])).toBe(1);
    expect(visibilityGate(controlled, [0, 1])).toBe(0.5);
    expect(visibilityGate(controlled, [-1, 0])).toBe(0);
  });

  it("uses goal direction rather than the opposite current velocity", () => {
    expect(visibilityGate(controlled, [1, 0])).toBe(1);
  });
});

describe("inverse-metric controller", () => {
  const controller = new RiemannianController(parameters);

  it("moves exactly toward the goal at preferred Euclidean speed in free space", () => {
    const controlled = agent(0, [1, 2], [0, 0], [4, 6], 1.5);
    const result = controller.computeTargetVelocity(controlled, identityMat2(), 0.01);
    expect(result.arrived).toBe(false);
    expect(result.targetVelocity[0]).toBeCloseTo(0.9, 14);
    expect(result.targetVelocity[1]).toBeCloseTo(1.2, 14);
    expect(Math.hypot(...result.targetVelocity)).toBeCloseTo(1.5, 14);
  });

  it("normalizes target velocity to preferred Riemannian speed", () => {
    const controlled = agent(0, [0, 0], [1, 0], [10, 1], 1.4);
    const neighbor = agent(1, [1, 0.1], [-1, 0], [-10, 0.1]);
    const { metric } = controller.computeEffectiveMetric(controlled, [neighbor]);
    const result = controller.computeTargetVelocity(controlled, metric, 0.01);
    expect(riemannianSpeed(result.targetVelocity, metric)).toBeCloseTo(controlled.preferredSpeed, 12);
  });

  it("returns zero and marks an agent at its goal arrived", () => {
    const controlled = agent(0, [2, 3], [4, 5], [2.01, 3], 1.4);
    const result = controller.computeTargetVelocity(controlled, identityMat2(), 0.02);
    expect(result).toEqual({ targetVelocity: [0, 0], arrived: true });
  });

  it("has no unexplained global lateral turning component", () => {
    const controlled = agent(0, [0, 0], [0, 5], [10, 0], 1.4);
    const result = controller.computeTargetVelocity(controlled, identityMat2(), 0.01);
    expect(result.targetVelocity[0]).toBeCloseTo(1.4, 15);
    expect(result.targetVelocity[1]).toBe(0);
  });

  it("skips coincident anisotropy and reports it", () => {
    const controlled = agent(0, [0, 0], [1, 0], [10, 0]);
    const neighbor = agent(
      1,
      [COINCIDENT_NEIGHBOR_EPSILON_METERS / 2, 0],
      [-1, 0],
      [-10, 0],
    );
    const result = controller.computeEffectiveMetric(controlled, [neighbor]);
    expect(result.metric).toEqual(identityMat2());
    expect(result.coincidentNeighborContributionsSkipped).toBe(1);
  });

  it("remains finite across valid deterministic random cases", () => {
    const random = lcg(12345);
    for (let testIndex = 0; testIndex < 200; testIndex += 1) {
      const controlled = agent(
        0,
        randomVec(random, -5, 5),
        randomVec(random, -2, 2),
        randomVec(random, 6, 10),
        0.5 + random() * 2,
      );
      const neighbors = Array.from({ length: 5 }, (_, index) =>
        agent(index + 1, randomVec(random, -5, 5), randomVec(random, -2, 2), randomVec(random, -10, -6)),
      );
      const { metric } = controller.computeEffectiveMetric(controlled, neighbors);
      const target = controller.computeTargetVelocity(controlled, metric, 1e-6).targetVelocity;
      expect([...target, metric.xx, metric.xy, metric.yx, metric.yy].every(Number.isFinite)).toBe(true);
    }
  });
});

function agent(
  id: number,
  position: Vec2,
  velocity: Vec2,
  goal: Vec2,
  preferredSpeed = 1,
): AgentState {
  return { id, position, velocity, goal, radius: 0.3, preferredSpeed, arrived: false };
}

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function randomVec(random: () => number, minimum: number, maximum: number): Vec2 {
  const component = (): number => minimum + (maximum - minimum) * random();
  return [component(), component()];
}
