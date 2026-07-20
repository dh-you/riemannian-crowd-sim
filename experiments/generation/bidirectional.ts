import type { AgentState, WallSegment } from "../../src/core/types";
import type { ExperimentScenario } from "../protocol/schema";
import { createScenario, makeAgent, speedWithHeterogeneity } from "./common";
import { DeterministicRandom } from "./random";

export function generateBidirectionalScenario(
  split: string,
  seed: number,
  agentCount: number,
): ExperimentScenario {
  if (!Number.isSafeInteger(agentCount) || agentCount < 4 || agentCount % 2 !== 0) {
    throw new Error("Bidirectional agent count must be an even integer of at least four");
  }
  const random = new DeterministicRandom(seed);
  const populationSize = agentCount / 2;
  const rows = agentCount >= 200 ? 8 : agentCount >= 100 ? 6 : Math.min(4, populationSize);
  const columns = Math.ceil(populationSize / rows);
  const corridorHalfWidth = Math.max(3, rows * 0.65);
  const agents: AgentState[] = [];
  for (let population = 0; population < 2; population += 1) {
    for (let localId = 0; localId < populationSize; localId += 1) {
      const row = localId % rows;
      const column = Math.floor(localId / rows);
      const centeredY = (row - (rows - 1) / 2) * 0.9;
      const jitterX = random.floatBetween(-0.035, 0.035);
      const jitterY = random.floatBetween(-0.035, 0.035);
      const baseX = -14 + column * 0.85;
      const positionX = population === 0 ? baseX + jitterX : -baseX - jitterX;
      const goalX = population === 0 ? 20 : -20;
      const id = population * populationSize + localId;
      agents.push(
        makeAgent(
          id,
          [positionX, centeredY + jitterY],
          [goalX, centeredY + jitterY],
          speedWithHeterogeneity(random.nextFloat()),
        ),
      );
    }
  }
  if (columns < 1) throw new Error("Bidirectional grid has no columns");
  const walls: WallSegment[] = [
    { id: 0, start: [-18, -corridorHalfWidth], end: [18, -corridorHalfWidth], thickness: 0.1 },
    { id: 1, start: [-18, corridorHalfWidth], end: [18, corridorHalfWidth], thickness: 0.1 },
  ];
  const completionRules = agents.map((agent) => {
    const rightMoving = agent.goal[0] > agent.position[0];
    return {
      agentId: agent.id,
      axis: "x" as const,
      threshold: rightMoving ? 17 : -17,
      direction: rightMoving ? "positive" as const : "negative" as const,
    };
  });
  return createScenario(
    { family: "bidirectional", variant: "corridor", split, seed },
    35,
    agents,
    walls,
    {
      completion: {
        completionSpecVersion: 1,
        rule: { type: "per_agent_directional_line", rules: completionRules },
        idealCompletionDistances: completionRules.map((rule) => {
          const agent = agents.find(({ id }) => id === rule.agentId);
          if (agent === undefined) throw new Error(`Missing corridor agent ${rule.agentId}`);
          return {
            agentId: rule.agentId,
            idealCompletionDistance: Math.abs(rule.threshold - agent.position[0]),
          };
        }),
      },
    },
  );
}
