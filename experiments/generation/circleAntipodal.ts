import type { ExperimentScenario } from "../protocol/schema";
import { createScenario, makeAgent, speedWithHeterogeneity } from "./common";
import { DeterministicRandom } from "./random";

export function generateCircleAntipodalScenario(
  split: string,
  seed: number,
  agentCount: number,
  exact = false,
): ExperimentScenario {
  if (!Number.isSafeInteger(agentCount) || agentCount < 2) {
    throw new Error("Circle agent count must be an integer of at least two");
  }
  const random = new DeterministicRandom(seed);
  const angularSpacing = (2 * Math.PI) / agentCount;
  const radius = Math.max(5, (agentCount * 0.75) / (2 * Math.PI));
  const agents = Array.from({ length: agentCount }, (_, id) => {
    const jitter = exact ? 0 : random.floatBetween(-0.04, 0.04) * angularSpacing;
    const angle = id * angularSpacing + jitter;
    const position = [radius * Math.cos(angle), radius * Math.sin(angle)] as const;
    const goal = [-position[0], -position[1]] as const;
    const speed = exact ? 1.4 : speedWithHeterogeneity(random.nextFloat());
    return makeAgent(id, position, goal, speed);
  });
  const idealTravelHorizon = Math.ceil(Math.max(...agents.map((agent) =>
    Math.max(0, Math.hypot(
      agent.goal[0] - agent.position[0],
      agent.goal[1] - agent.position[1],
    ) - 0.1) / agent.preferredSpeed)));
  return createScenario(
    {
      family: "circle_antipodal",
      variant: exact ? "exact_diagnostic" : "perturbed",
      split,
      seed,
    },
    Math.max(30, idealTravelHorizon),
    agents,
  );
}
