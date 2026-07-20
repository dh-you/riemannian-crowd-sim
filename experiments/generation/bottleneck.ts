import type { WallSegment } from "../../src/core/types";
import type { ExperimentScenario } from "../protocol/schema";
import { createScenario, makeAgent, speedWithHeterogeneity } from "./common";
import { DeterministicRandom } from "./random";

export interface BottleneckGenerationParameters {
  openingWidth?: number;
  initialSpacing?: number;
  spawnJitter?: number;
  speedHeterogeneity?: number;
}

export function generateBottleneckScenario(
  split: string,
  seed: number,
  agentCount: number,
  parameters: BottleneckGenerationParameters = {},
): ExperimentScenario {
  if (!Number.isSafeInteger(agentCount) || agentCount < 4) {
    throw new Error("Bottleneck agent count must be an integer of at least four");
  }
  const openingWidth = parameters.openingWidth ?? 2.4;
  const initialSpacing = parameters.initialSpacing ?? 0.72;
  const spawnJitter = parameters.spawnJitter ?? 0.025;
  const speedHeterogeneity = parameters.speedHeterogeneity ?? 0.1;
  if (!Number.isFinite(openingWidth) || openingWidth <= 0) {
    throw new Error("Bottleneck opening width must be positive and finite");
  }
  if (!Number.isFinite(initialSpacing) || initialSpacing <= 0) {
    throw new Error("Bottleneck initial spacing must be positive and finite");
  }
  if (!Number.isFinite(spawnJitter) || spawnJitter < 0) {
    throw new Error("Bottleneck spawn jitter must be finite and nonnegative");
  }
  const random = new DeterministicRandom(seed);
  const rows = agentCount >= 200 ? 16 : agentCount >= 100 ? 14 : Math.min(6, agentCount);
  const agents = Array.from({ length: agentCount }, (_, id) => {
    const row = id % rows;
    const column = Math.floor(id / rows);
    const y =
      (row - (rows - 1) / 2) * initialSpacing + random.floatBetween(-spawnJitter, spawnJitter);
    const x = -12 + column * initialSpacing + random.floatBetween(-spawnJitter, spawnJitter);
    return makeAgent(
      id,
      [x, y],
      [10, y],
      speedWithHeterogeneity(random.nextFloat(), speedHeterogeneity),
    );
  });
  const walls: WallSegment[] = [
    { id: 0, start: [-14, -6], end: [12, -6], thickness: 0.1 },
    { id: 1, start: [-14, 6], end: [12, 6], thickness: 0.1 },
    { id: 2, start: [-14, -6], end: [-14, 6], thickness: 0.1 },
    { id: 3, start: [12, -6], end: [12, 6], thickness: 0.1 },
    { id: 4, start: [0, -6], end: [0, -openingWidth / 2], thickness: 0.1 },
    { id: 5, start: [0, openingWidth / 2], end: [0, 6], thickness: 0.1 },
  ];
  return createScenario(
    { family: "bottleneck", variant: "central_opening", split, seed },
    40,
    agents,
    walls,
    {
      completion: {
        completionSpecVersion: 1,
        rule: { type: "directional_line", axis: "x", threshold: 8, direction: "positive" },
        idealCompletionDistances: agents.map((agent) => ({
          agentId: agent.id,
          idealCompletionDistance: Math.hypot(1.5 - agent.position[0], agent.position[1]) + 6.5,
        })),
      },
      navigation: {
        type: "waypoint_then_point_goal",
        waypoint: [1.5, 0],
        switchLine: { type: "directional_line", axis: "x", threshold: 1, direction: "positive" },
      },
    },
  );
}
