import { describe, expect, it } from "vitest";
import { correctPositions } from "../../src/core/corrections";
import { norm, sub } from "../../src/core/math";
import { SimulatorCore } from "../../src/core/SimulatorCore";
import { CONTROLLER_ID, type AgentState, type Vec2, type WallSegment } from "../../src/core/types";

describe("deterministic positional correction", () => {
  it("separates overlapping agents symmetrically and measures displacement", () => {
    const agents = overlappingAgents();
    const positions = new Map(agents.map((agent) => [agent.id, agent.position]));
    const result = correctPositions(
      agents,
      [],
      positions,
      { enabled: true, iterations: 2, padding: 0.001 },
    );
    const first = result.positions.get(1)!;
    const second = result.positions.get(2)!;
    expect(norm(sub(first, second))).toBeCloseTo(1.001, 12);
    expect((first[0] + second[0]) / 2).toBeCloseTo(0, 15);
    expect((first[1] + second[1]) / 2).toBeCloseTo(0, 15);
    expect(result.agentDisplacementById.get(1)).toBeCloseTo(result.agentDisplacementById.get(2)!, 15);
    expect(result.totalAgentCorrectionDisplacement).toBeGreaterThan(0);
    expect(result.correctedAgentPairs).toBe(1);
  });

  it("uses a stable fallback direction for exactly coincident agents", () => {
    const agents = overlappingAgents([0, 0], [0, 0]);
    const positions = new Map(agents.map((agent) => [agent.id, agent.position]));
    const parameters = { enabled: true, iterations: 1, padding: 0.001 } as const;
    const first = correctPositions(agents, [], positions, parameters);
    const second = correctPositions([...agents].reverse(), [], positions, parameters);
    expect(first.positions).toEqual(second.positions);
    expect(norm(sub(first.positions.get(1)!, first.positions.get(2)!))).toBeCloseTo(1.001, 12);
  });

  it("reduces simple overlap and reports pre/post diagnostics", () => {
    const agents = overlappingAgents();
    const simulator = new SimulatorCore({
      agents,
      walls: [],
      simulation: {
        dt: 0.1,
        goalTolerance: 0.01,
        velocityTimeConstant: 0,
        correction: { enabled: true, iterations: 2, padding: 0.001 },
      },
      controller: { id: CONTROLLER_ID, alpha: 0, sigma: 2, lambdaR: 2, lambdaT: 1 },
    });
    const diagnostic = simulator.step();
    expect(diagnostic.preCorrectionOverlapPairs).toBe(1);
    expect(diagnostic.postCorrectionOverlapPairs).toBe(0);
    expect(diagnostic.maxPostCorrectionPenetration).toBe(0);
    expect(diagnostic.agentCorrectionDisplacement).toBeGreaterThan(0);
    expect(diagnostic.correctedAgentPairs).toBe(1);
  });

  it("projects agents to radius plus half thickness plus padding from a wall", () => {
    const agent = baseAgent(7, [0, 0.1]);
    const wall: WallSegment = { id: 3, start: [-2, 0], end: [2, 0], thickness: 0.2 };
    const result = correctPositions(
      [agent],
      [wall],
      new Map([[agent.id, agent.position]]),
      { enabled: true, iterations: 2, padding: 0.05 },
    );
    expect(result.positions.get(agent.id)![1]).toBeCloseTo(0.65, 13);
    expect(result.wallDisplacementById.get(agent.id)).toBeCloseTo(0.55, 13);
    expect(result.correctedWallContacts).toBe(1);
  });

  it("uses a deterministic fallback normal on a wall centerline", () => {
    const agent = baseAgent(7, [0, 0]);
    const wall: WallSegment = { id: 3, start: [-2, 0], end: [2, 0], thickness: 0.2 };
    const positions = new Map([[agent.id, agent.position]]);
    const parameters = { enabled: true, iterations: 1, padding: 0.05 } as const;
    const first = correctPositions([agent], [wall], positions, parameters);
    const second = correctPositions([agent], [wall], positions, parameters);
    expect(first.positions).toEqual(second.positions);
    expect(Math.abs(first.positions.get(agent.id)![1])).toBeCloseTo(0.65, 13);
  });
});

function overlappingAgents(firstPosition: Vec2 = [-0.1, 0], secondPosition: Vec2 = [0.1, 0]): AgentState[] {
  return [baseAgent(1, firstPosition), baseAgent(2, secondPosition)];
}

function baseAgent(id: number, position: Vec2): AgentState {
  return {
    id,
    position,
    velocity: [0, 0],
    goal: position,
    radius: 0.5,
    preferredSpeed: 1,
    arrived: false,
  };
}
