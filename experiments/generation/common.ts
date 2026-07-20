import { closestPointOnSegment, norm, scale, sub } from "../../src/core/math";
import type { AgentState, Vec2, WallSegment } from "../../src/core/types";
import {
  EXPERIMENT_SCENARIO_VERSION,
  parseExperimentScenario,
  serializeExperimentScenario,
  type ExperimentScenario,
  type ProtocolNavigation,
  type ScenarioCompletion,
} from "../protocol/schema";

export const GENERATOR_VERSION = "protocol_v1";
export const DEFAULT_DT = 1 / 60;
export const DEFAULT_RADIUS = 0.3;
export const DEFAULT_PREFERRED_SPEED = 1.4;
export const INITIAL_OVERLAP_TOLERANCE_METERS = 1e-10;

export interface ScenarioIdentity {
  family: string;
  variant: string;
  split: string;
  seed: number;
}

export function createScenario(
  identity: ScenarioIdentity,
  horizonSeconds: number,
  agents: AgentState[],
  walls: WallSegment[] = [],
  protocol?: {
    completion?: ScenarioCompletion;
    navigation?: ProtocolNavigation;
  },
): ExperimentScenario {
  const completion = protocol?.completion ?? goalDiskCompletion(agents, 0.1);
  const scenario: ExperimentScenario = {
    experimentScenarioVersion: EXPERIMENT_SCENARIO_VERSION,
    name:
      identity.split === "diagnostic"
        ? `${identity.family}-${identity.variant}`
        : `${identity.family}-${identity.variant}-${identity.split}-seed-${identity.seed}`,
    family: identity.family,
    variant: identity.variant,
    split: identity.split,
    seed: identity.seed,
    simulation: {
      dt: DEFAULT_DT,
      horizonSeconds,
      goalTolerance: 0.1,
      correction: { enabled: true, iterations: 2, padding: 0.001 },
    },
    agents: [...agents].sort((a, b) => a.id - b.id),
    walls: [...walls].sort((a, b) => a.id - b.id),
    completion,
    navigation: protocol?.navigation ?? { type: "point_goal" },
    metadata: { units: { distance: "m", time: "s" } },
  };
  assertNoInitialPhysicalOverlaps(scenario);
  return parseExperimentScenario(JSON.parse(serializeExperimentScenario(scenario)) as unknown);
}

export function goalDiskCompletion(
  agents: readonly AgentState[],
  goalTolerance: number,
): ScenarioCompletion {
  return {
    completionSpecVersion: 1,
    rule: { type: "goal_disk" },
    idealCompletionDistances: agents.map((agent) => ({
      agentId: agent.id,
      idealCompletionDistance: Math.max(
        0,
        norm(sub(agent.goal, agent.position)) - goalTolerance,
      ),
    })),
  };
}

export function makeAgent(
  id: number,
  position: Vec2,
  goal: Vec2,
  preferredSpeed: number,
  radius = DEFAULT_RADIUS,
): AgentState {
  const offset = sub(goal, position);
  const distance = norm(offset);
  if (distance === 0) throw new Error(`Generated agent ${id} has a zero-length goal direction`);
  return {
    id,
    position,
    goal,
    velocity: scale(offset, preferredSpeed / distance),
    radius,
    preferredSpeed,
    arrived: false,
  };
}

export function assertNoInitialPhysicalOverlaps(
  scenario: Pick<ExperimentScenario, "agents" | "walls">,
  tolerance = INITIAL_OVERLAP_TOLERANCE_METERS,
): void {
  const agents = [...scenario.agents].sort((a, b) => a.id - b.id);
  for (let firstIndex = 0; firstIndex < agents.length; firstIndex += 1) {
    const first = agents[firstIndex];
    for (let secondIndex = firstIndex + 1; secondIndex < agents.length; secondIndex += 1) {
      const second = agents[secondIndex];
      const clearance = norm(sub(first.position, second.position)) - first.radius - second.radius;
      if (clearance < -tolerance) {
        throw new Error(`Generated agents ${first.id} and ${second.id} overlap by ${-clearance} m`);
      }
    }
    for (const wall of scenario.walls) {
      const closest = closestPointOnSegment(first.position, wall.start, wall.end);
      const clearance = norm(sub(first.position, closest)) - first.radius - wall.thickness / 2;
      if (clearance < -tolerance) {
        throw new Error(`Generated agent ${first.id} initially penetrates wall ${wall.id}`);
      }
    }
  }
}

export function speedWithHeterogeneity(randomValue: number, fractionalRange = 0.1): number {
  if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue >= 1) {
    throw new Error("Speed heterogeneity sample must lie in [0, 1)");
  }
  if (!Number.isFinite(fractionalRange) || fractionalRange < 0 || fractionalRange >= 1) {
    throw new Error("Speed heterogeneity range must lie in [0, 1)");
  }
  return DEFAULT_PREFERRED_SPEED * (1 - fractionalRange + 2 * fractionalRange * randomValue);
}
