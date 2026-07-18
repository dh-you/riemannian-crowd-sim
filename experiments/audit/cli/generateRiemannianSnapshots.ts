import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentState, Vec2 } from "../../../src/core/types";

interface Snapshot {
  caseId: string;
  parameters: { alpha: number; sigma: number; lambdaR: number; lambdaT: number };
  goalTolerance: number;
  controlled: AgentState;
  neighbors: AgentState[];
  expectFreeSpace?: boolean;
  expectSeparatingEqualsFreeSpace?: boolean;
}

const PARAMETERS = { alpha: 10, sigma: 2.4, lambdaR: 10, lambdaT: 1 } as const;

function agent(
  id: number,
  position: Vec2,
  velocity: Vec2,
  goal: Vec2 = [5, 0],
  preferredSpeed = 1.3,
): AgentState {
  return { id, position, velocity, goal, preferredSpeed, radius: 0.3, arrived: false };
}

export function buildSnapshots(): Snapshot[] {
  const controlled = agent(0, [0, 0], [0.4, 0]);
  const special: Snapshot[] = [
    { caseId: "no-neighbor", parameters: PARAMETERS, goalTolerance: 0.05, controlled, neighbors: [], expectFreeSpace: true },
    { caseId: "approaching-radial", parameters: PARAMETERS, goalTolerance: 0.05, controlled, neighbors: [agent(1, [1, 0], [-0.9, 0])] },
    { caseId: "separating", parameters: PARAMETERS, goalTolerance: 0.05, controlled: agent(0, [0, 0], [0, 0]), neighbors: [agent(1, [1, 0], [1, 0])], expectSeparatingEqualsFreeSpace: true },
    { caseId: "behind", parameters: PARAMETERS, goalTolerance: 0.05, controlled, neighbors: [agent(1, [-1, 0], [1, 0])], expectFreeSpace: true },
    { caseId: "oblique-crossing", parameters: PARAMETERS, goalTolerance: 0.05, controlled, neighbors: [agent(1, [0.9, 0.7], [-0.5, -0.8])] },
    { caseId: "multiple-neighbors", parameters: PARAMETERS, goalTolerance: 0.05, controlled, neighbors: [agent(3, [1.4, -0.4], [-0.4, 0.3]), agent(1, [0.8, 0.6], [-0.9, -0.4]), agent(2, [-0.3, 1.1], [0.2, -0.8])] },
    { caseId: "support-boundary", parameters: PARAMETERS, goalTolerance: 0.05, controlled, neighbors: [agent(1, [PARAMETERS.sigma * (1 - 1e-10), 0], [-0.9, 0])] },
  ];
  let state = 0x5eeda11d;
  const random = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  const randomCases = Array.from({ length: 100 }, (_, caseIndex): Snapshot => {
    const angle = random() * Math.PI * 2;
    const goalDistance = 2 + random() * 6;
    const controlledRandom = agent(
      1000 + caseIndex * 10,
      [(random() - 0.5) * 4, (random() - 0.5) * 4],
      [(random() - 0.5) * 2, (random() - 0.5) * 2],
      [Math.cos(angle) * goalDistance, Math.sin(angle) * goalDistance],
      0.5 + random() * 1.5,
    );
    const neighborCount = 1 + Math.floor(random() * 5);
    const neighbors = Array.from({ length: neighborCount }, (_, neighborIndex) => {
      const radialAngle = random() * Math.PI * 2;
      const radialDistance = 0.05 + random() * (PARAMETERS.sigma * 1.2 - 0.05);
      return agent(
        controlledRandom.id + neighborIndex + 1,
        [
          controlledRandom.position[0] + Math.cos(radialAngle) * radialDistance,
          controlledRandom.position[1] + Math.sin(radialAngle) * radialDistance,
        ],
        [(random() - 0.5) * 3, (random() - 0.5) * 3],
        [0, 0],
        0.5 + random() * 1.5,
      );
    });
    if (caseIndex % 2 === 1) neighbors.reverse();
    return {
      caseId: `random-${caseIndex.toString().padStart(3, "0")}`,
      parameters: {
        alpha: 1 + random() * 15,
        sigma: PARAMETERS.sigma,
        lambdaR: 1 + random() * 14,
        lambdaT: 0.5 + random() * 2,
      },
      goalTolerance: 0.05,
      controlled: controlledRandom,
      neighbors,
    };
  });
  return [...special, ...randomCases];
}

function main(): void {
  const outputPath = process.argv[2] ?? "experiments/audit/fixtures/riemannian-snapshots.jsonl";
  const serialized = buildSnapshots().map((snapshot) => JSON.stringify(snapshot)).join("\n") + "\n";
  mkdirSync(dirname(resolve(outputPath)), { recursive: true });
  writeFileSync(outputPath, serialized, "utf8");
  console.log(`wrote ${buildSnapshots().length} Riemannian snapshots to ${outputPath}`);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) main();
