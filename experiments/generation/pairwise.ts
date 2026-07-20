import type { AgentState, Vec2 } from "../../src/core/types";
import type { ExperimentScenario } from "../protocol/schema";
import {
  createScenario,
  DEFAULT_PREFERRED_SPEED,
  makeAgent,
  speedWithHeterogeneity,
} from "./common";
import { DeterministicRandom } from "./random";

export const PAIRWISE_VARIANTS = [
  "head_on",
  "crossing",
  "overtaking",
  "separating",
  "exact_symmetric_diagnostic",
] as const;
export type PairwiseVariant = (typeof PAIRWISE_VARIANTS)[number];

export function generatePairwiseScenario(
  variant: PairwiseVariant,
  split: string,
  seed: number,
): ExperimentScenario {
  if (variant === "exact_symmetric_diagnostic") return exactSymmetricScenario();
  const random = new DeterministicRandom(seed);
  let agents: AgentState[];
  switch (variant) {
    case "head_on":
      agents = headOnAgents(random);
      break;
    case "crossing":
      agents = crossingAgents(random);
      break;
    case "overtaking":
      agents = overtakingAgents(random);
      break;
    case "separating":
      agents = separatingAgents(random);
      break;
  }
  const horizonSeconds = variant === "head_on" || variant === "crossing" ? 30 : 15;
  return createScenario({ family: "pairwise", variant, split, seed }, horizonSeconds, agents);
}

function headOnAgents(random: DeterministicRandom): AgentState[] {
  const halfDistance = random.floatBetween(4.5, 6);
  const lateralMagnitude = random.floatBetween(0.04, 0.16);
  const lateralSign = random.integerBetween(0, 2) === 0 ? -1 : 1;
  const lateral = lateralSign * lateralMagnitude;
  const firstSpeed = speedWithHeterogeneity(random.nextFloat());
  const secondSpeed = speedWithHeterogeneity(random.nextFloat());
  return [
    makeAgent(0, [-halfDistance, -lateral / 2], [halfDistance, -lateral / 2], firstSpeed),
    makeAgent(1, [halfDistance, lateral / 2], [-halfDistance, lateral / 2], secondSpeed),
  ];
}

function crossingAgents(random: DeterministicRandom): AgentState[] {
  const firstSpeed = speedWithHeterogeneity(random.nextFloat());
  const secondSpeed = speedWithHeterogeneity(random.nextFloat());
  const firstDistance = random.floatBetween(4.5, 5.5);
  const timingOffset = random.floatBetween(-0.35, 0.35);
  const secondDistance = Math.max(4, (firstDistance / firstSpeed + timingOffset) * secondSpeed);
  const firstOffset = random.floatBetween(-0.12, 0.12);
  const secondOffset = random.floatBetween(-0.12, 0.12);
  return [
    makeAgent(0, [-firstDistance, firstOffset], [firstDistance, firstOffset], firstSpeed),
    makeAgent(1, [secondOffset, -secondDistance], [secondOffset, secondDistance], secondSpeed),
  ];
}

function overtakingAgents(random: DeterministicRandom): AgentState[] {
  const laneOffset = random.floatBetween(-0.08, 0.08);
  const leaderSpeed = random.floatBetween(1.15, 1.3);
  const followerSpeed = random.floatBetween(1.5, 1.65);
  return [
    makeAgent(0, [-5, -laneOffset], [9, -laneOffset], followerSpeed),
    makeAgent(1, [-2.5, laneOffset], [9, laneOffset], leaderSpeed),
  ];
}

function separatingAgents(random: DeterministicRandom): AgentState[] {
  const offset = random.floatBetween(0.65, 0.85);
  const vertical = random.floatBetween(-0.08, 0.08);
  return [
    makeAgent(0, [-offset, vertical], [-6, vertical], speedWithHeterogeneity(random.nextFloat())),
    makeAgent(1, [offset, -vertical], [6, -vertical], speedWithHeterogeneity(random.nextFloat())),
  ];
}

function exactSymmetricScenario(): ExperimentScenario {
  const left: Vec2 = [-5, 0];
  const right: Vec2 = [5, 0];
  return createScenario(
    { family: "pairwise", variant: "exact_symmetric_diagnostic", split: "diagnostic", seed: 0 },
    15,
    [
      makeAgent(0, left, right, DEFAULT_PREFERRED_SPEED),
      makeAgent(1, right, left, DEFAULT_PREFERRED_SPEED),
    ],
  );
}
