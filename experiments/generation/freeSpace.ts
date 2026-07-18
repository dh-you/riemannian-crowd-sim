import type { ExperimentScenario } from "../protocol/schema";
import { createScenario, makeAgent } from "./common";

export function generateFreeSpaceScenario(split: string, seed: number): ExperimentScenario {
  return createScenario(
    { family: "free_space", variant: "single_agent", split, seed },
    10,
    [makeAgent(0, [-3, 0], [3, 0], 1.4)],
  );
}
