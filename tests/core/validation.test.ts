import { describe, expect, it } from "vitest";
import { parseScenario } from "../../experiments/schema/scenario";

describe("scenario validation", () => {
  it("accepts the versioned scientific scenario", () => {
    expect(parseScenario(validScenario()).controller.id).toBe("conditioned_riemannian_metric_v1");
  });

  it("rejects unsupported schema and controller IDs", () => {
    const schema = validScenario();
    schema.schemaVersion = 2;
    expect(() => parseScenario(schema)).toThrow(/schemaVersion/u);
    const controller = validScenario();
    controller.controller.id = "legacy";
    expect(() => parseScenario(controller)).toThrow(/controller id/u);
  });

  it("rejects duplicate IDs and invalid agent radii or speeds", () => {
    const duplicate = validScenario();
    duplicate.agents.push({ ...duplicate.agents[0] });
    expect(() => parseScenario(duplicate)).toThrow(/Duplicate agent id/u);
    const radius = validScenario();
    radius.agents[0].radius = 0;
    expect(() => parseScenario(radius)).toThrow(/radius must be positive/u);
    const speed = validScenario();
    speed.agents[0].preferredSpeed = -1;
    expect(() => parseScenario(speed)).toThrow(/preferredSpeed must be positive/u);
  });

  it("rejects non-finite numbers, nonpositive dt, and negative horizon", () => {
    const finite = validScenario();
    finite.controller.alpha = Number.POSITIVE_INFINITY;
    expect(() => parseScenario(finite)).toThrow(/finite/u);
    const dt = validScenario();
    dt.simulation.dt = 0;
    expect(() => parseScenario(dt)).toThrow(/dt must be positive/u);
    const horizon = validScenario();
    horizon.simulation.horizonSeconds = -1;
    expect(() => parseScenario(horizon)).toThrow(/horizonSeconds must be nonnegative/u);
  });

  it("rejects malformed vectors and invalid wall segments", () => {
    const vector = validScenario();
    vector.agents[0].position = [0];
    expect(() => parseScenario(vector)).toThrow(/two-element vector/u);
    const wall = validScenario();
    wall.walls.push({ id: 0, start: [1, 1], end: [1, 1], thickness: 0.1 });
    expect(() => parseScenario(wall)).toThrow(/distinct finite endpoints/u);
  });

  it("rejects invalid controller parameters", () => {
    for (const field of ["alpha", "sigma", "lambdaR", "lambdaT"] as const) {
      const scenario = validScenario();
      scenario.controller[field] = -1;
      expect(() => parseScenario(scenario)).toThrow();
    }
  });
});

function validScenario() {
  return {
    schemaVersion: 1,
    name: "test",
    seed: 1,
    simulation: {
      dt: 0.1,
      horizonSeconds: 1,
      goalTolerance: 0.01,
      velocityTimeConstant: 0,
      correction: { enabled: false, iterations: 0, padding: 0 },
    },
    controller: {
      id: "conditioned_riemannian_metric_v1",
      alpha: 1,
      sigma: 2,
      lambdaR: 2,
      lambdaT: 1,
    },
    agents: [{
      id: 0,
      radius: 0.3,
      preferredSpeed: 1,
      position: [0, 0],
      velocity: [0, 0],
      goal: [1, 0],
    }],
    walls: [] as Array<{ id: number; start: number[]; end: number[]; thickness: number }>,
  };
}
