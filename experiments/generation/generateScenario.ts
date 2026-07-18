import type { ExperimentScenario } from "../protocol/schema";
import { generateBidirectionalScenario } from "./bidirectional";
import { generateBottleneckScenario } from "./bottleneck";
import { generateCircleAntipodalScenario } from "./circleAntipodal";
import { generateFreeSpaceScenario } from "./freeSpace";
import { generatePairwiseScenario, PAIRWISE_VARIANTS, type PairwiseVariant } from "./pairwise";

export interface ScenarioGenerationRequest {
  family: string;
  variant: string;
  split: string;
  seed: number;
  agentCount?: number;
}

export function generateExperimentScenario(request: ScenarioGenerationRequest): ExperimentScenario {
  switch (request.family) {
    case "pairwise":
      if (!PAIRWISE_VARIANTS.includes(request.variant as PairwiseVariant)) {
        throw new Error(`Unsupported pairwise variant: ${request.variant}`);
      }
      return generatePairwiseScenario(request.variant as PairwiseVariant, request.split, request.seed);
    case "circle_antipodal":
      return generateCircleAntipodalScenario(
        request.split,
        request.seed,
        requireAgentCount(request),
        request.variant === "exact_diagnostic",
      );
    case "bidirectional":
      if (request.variant !== "corridor") throw new Error(`Unsupported bidirectional variant: ${request.variant}`);
      return generateBidirectionalScenario(request.split, request.seed, requireAgentCount(request));
    case "bottleneck":
      if (request.variant !== "central_opening") throw new Error(`Unsupported bottleneck variant: ${request.variant}`);
      return generateBottleneckScenario(request.split, request.seed, requireAgentCount(request));
    case "free_space":
      if (request.variant !== "single_agent") throw new Error(`Unsupported free-space variant: ${request.variant}`);
      return generateFreeSpaceScenario(request.split, request.seed);
    default:
      throw new Error(`Unsupported scenario family: ${request.family}`);
  }
}

function requireAgentCount(request: ScenarioGenerationRequest): number {
  if (request.agentCount === undefined) {
    throw new Error(`Scenario family ${request.family} requires agentCount`);
  }
  return request.agentCount;
}
