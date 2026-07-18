import { describe, expect, it } from "vitest";
import {
  dot,
  quadraticForm,
  symmetricEigenvalues,
} from "../../src/core/math";
import {
  anisotropicTensor,
  RiemannianController,
} from "../../src/core/RiemannianController";
import { smoothstep, wendlandC2 } from "../../src/core/smoothstep";
import { CONTROLLER_ID, type AgentState } from "../../src/core/types";

describe("Wendland C2 kernel", () => {
  it("has the required support and endpoint values", () => {
    expect(wendlandC2(0)).toBe(1);
    expect(wendlandC2(1)).toBe(0);
    expect(wendlandC2(1.5)).toBe(0);
  });

  it("is nonnegative throughout its support", () => {
    for (let index = 0; index <= 100; index += 1) {
      expect(wendlandC2(index / 100)).toBeGreaterThanOrEqual(0);
    }
  });

  it("rejects negative and non-finite distances", () => {
    expect(() => wendlandC2(-0.1)).toThrow();
    expect(() => wendlandC2(Number.NaN)).toThrow();
  });
});

describe("clamped cubic smoothstep", () => {
  it("clamps endpoints and has a midpoint of one half", () => {
    expect(smoothstep(0, 2, -1)).toBe(0);
    expect(smoothstep(0, 2, 0)).toBe(0);
    expect(smoothstep(0, 2, 1)).toBe(0.5);
    expect(smoothstep(0, 2, 2)).toBe(1);
    expect(smoothstep(0, 2, 3)).toBe(1);
  });

  it("is monotone", () => {
    const values = Array.from({ length: 101 }, (_, index) => smoothstep(-1, 1, -1 + index / 50));
    for (let index = 1; index < values.length; index += 1) {
      expect(values[index]).toBeGreaterThanOrEqual(values[index - 1]);
    }
  });
});

describe("anisotropic tensor", () => {
  it("is symmetric with the specified radial and tangential eigenvalues", () => {
    const radial = [3 / 5, 4 / 5] as const;
    const tangential = [-4 / 5, 3 / 5] as const;
    const matrix = anisotropicTensor(radial, 7, 2);
    expect(matrix.xy).toBe(matrix.yx);
    expect(quadraticForm(radial, matrix)).toBeCloseTo(7, 13);
    expect(quadraticForm(tangential, matrix)).toBeCloseTo(2, 13);
    expect(dot(radial, tangential)).toBeCloseTo(0, 15);
  });
});

describe("effective metric", () => {
  it("is symmetric positive definite with minimum eigenvalue at least one", () => {
    const controlled = agent(0, [0, 0], [1, 0], [10, 0]);
    const neighbor = agent(1, [1, 0.25], [-1, 0], [-10, 0.25]);
    const controller = new RiemannianController({
      id: CONTROLLER_ID,
      alpha: 10,
      sigma: 2.4,
      lambdaR: 10,
      lambdaT: 1,
    });
    const { metric } = controller.computeEffectiveMetric(controlled, [neighbor]);
    const eigenvalues = symmetricEigenvalues(metric);
    expect(metric.xy).toBeCloseTo(metric.yx, 15);
    expect(eigenvalues[0]).toBeGreaterThanOrEqual(1 - 1e-12);
    expect(eigenvalues[1]).toBeGreaterThan(0);
  });
});

function agent(id: number, position: readonly [number, number], velocity: readonly [number, number], goal: readonly [number, number]): AgentState {
  return { id, position, velocity, goal, radius: 0.3, preferredSpeed: 1, arrived: false };
}
