import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeClosestPreCorrectionEncounter,
  computeFirstAvoidanceOnsets,
} from "../../experiments/audit/viewer/generateReviewIndex";
import type { EngineStepRecord } from "../../experiments/engines/engineStep";
import type { ExperimentScenario } from "../../experiments/protocol/schema";

const scenario: ExperimentScenario = {
  experimentScenarioVersion: 1,
  name: "viewer-fixture",
  family: "pairwise",
  variant: "head_on",
  split: "audit",
  seed: 0,
  simulation: {
    dt: 0.1,
    horizonSeconds: 0.2,
    goalTolerance: 0.05,
    correction: { enabled: true, iterations: 2, padding: 0.001 },
  },
  agents: [
    {
      id: 0,
      radius: 0.3,
      preferredSpeed: 1,
      position: [-1, 0],
      velocity: [1, 0],
      goal: [1, 0],
      arrived: false,
    },
    {
      id: 1,
      radius: 0.2,
      preferredSpeed: 1,
      position: [1, 0],
      velocity: [-1, 0],
      goal: [-1, 0],
      arrived: false,
    },
  ],
  walls: [],
  metadata: { units: { distance: "m", time: "s" } },
};

describe("Stage D0 trajectory review viewer", () => {
  it("finds the globally closest physical pre-correction encounter", () => {
    const closest = computeClosestPreCorrectionEncounter(scenario, [
      step(0, 0.1, [-0.5, 0], [0.5, 0], [-0.5, 0], [0.5, 0]),
      step(1, 0.2, [-0.1, 0], [0.1, 0], [-0.25, 0], [0.25, 0]),
    ]);
    expect(closest).not.toBeNull();
    expect(closest?.stepIndex).toBe(1);
    expect(closest?.centerDistance).toBeCloseTo(0.2, 15);
    expect(closest?.physicalClearance).toBeCloseTo(-0.3, 15);
    expect(closest?.firstPostCorrectionPosition).toEqual([-0.25, 0]);
    expect(closest?.secondPostCorrectionPosition).toEqual([0.25, 0]);
  });

  it("marks each agent's first command deflection greater than five degrees", () => {
    const direct = step(0, 0.1, [-0.9, 0], [0.9, 0], [-0.9, 0], [0.9, 0]);
    const deflected = step(1, 0.2, [-0.8, 0], [0.8, 0], [-0.8, 0], [0.8, 0]);
    deflected.agents[0].commandVelocity = [1, 0.2];
    deflected.agents[1].commandVelocity = [-1, -0.2];
    const later = step(2, 0.3, [-0.7, 0], [0.7, 0], [-0.7, 0], [0.7, 0]);
    later.agents[0].commandVelocity = [0, 1];
    later.agents[1].commandVelocity = [0, -1];

    const onsets = computeFirstAvoidanceOnsets(scenario, [direct, deflected, later]);
    expect(onsets.map((onset) => onset.agentId)).toEqual([0, 1]);
    expect(onsets.every((onset) => onset.stepIndex === 1)).toBe(true);
    expect(onsets.every((onset) => onset.time === 0.1)).toBe(true);
    expect(onsets[0].position).toEqual(deflected.agents[0].positionBefore);
  });

  it("keeps the viewer audit-only and includes every requested review cue", () => {
    const html = readFileSync(resolve("experiments/audit/viewer/index.html"), "utf8");
    const script = readFileSync(resolve("experiments/audit/viewer/viewer.js"), "utf8");
    for (const phrase of [
      "PENDING HUMAN REVIEW",
      "Pre-correction",
      "Post-correction",
      "Trajectory trails",
      "Agent IDs",
      "teleportation",
      "wall crossing",
      "oscillation",
      "Arrival",
      "projection dependence",
    ]) {
      expect(html.toLowerCase()).toContain(phrase.toLowerCase());
    }
    expect(script).toContain("physicalClearance");
    expect(script).toContain("closestPreCorrectionEncounter");
    expect(script).not.toContain("human-visual-review.json");
  });
});

function step(
  stepIndex: number,
  time: number,
  firstPre: [number, number],
  secondPre: [number, number],
  firstPost: [number, number],
  secondPost: [number, number],
): EngineStepRecord {
  return {
    engineStepVersion: 1,
    stepIndex,
    time,
    agents: [
      {
        id: 0,
        positionBefore: firstPre,
        velocityBefore: [1, 0],
        preCorrectionPosition: firstPre,
        postCorrectionPosition: firstPost,
        commandVelocity: [1, 0],
        realizedVelocity: [1, 0],
        arrived: false,
      },
      {
        id: 1,
        positionBefore: secondPre,
        velocityBefore: [-1, 0],
        preCorrectionPosition: secondPre,
        postCorrectionPosition: secondPost,
        commandVelocity: [-1, 0],
        realizedVelocity: [-1, 0],
        arrived: false,
      },
    ],
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
      intendedDisplacement: 0,
      agentCorrectionDisplacement: 0,
      wallCorrectionDisplacement: 0,
      totalCorrectionDisplacement: 0,
      correctionMode: "shared_projection",
    },
  };
}
