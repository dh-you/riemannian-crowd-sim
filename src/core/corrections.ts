import { add, closestPointOnSegment, norm, normalize, scale, sub } from "./math";
import type { AgentState, CorrectionParameters, Vec2, WallSegment } from "./types";
import { validateCorrectionParameters } from "./validation";
import { requirePosition, type PositionMap } from "./diagnostics";

const CORRECTION_DIRECTION_EPSILON_METERS = 1e-12;

export interface CorrectionResult {
  positions: Map<number, Vec2>;
  agentDisplacementById: Map<number, number>;
  wallDisplacementById: Map<number, number>;
  correctedAgentPairs: number;
  correctedWallContacts: number;
  totalAgentCorrectionDisplacement: number;
  totalWallCorrectionDisplacement: number;
}

/**
 * Applies fixed-count Jacobi passes. Agent pair and wall contributions are each
 * accumulated before simultaneous application, so input or contact order cannot
 * alter a pass.
 */
export function correctPositions(
  agents: readonly AgentState[],
  walls: readonly WallSegment[],
  initialPositions: PositionMap,
  parameters: CorrectionParameters,
): CorrectionResult {
  validateCorrectionParameters(parameters);
  const orderedAgents = [...agents].sort((a, b) => a.id - b.id);
  const orderedWalls = [...walls].sort((a, b) => a.id - b.id);
  const positions = new Map<number, Vec2>();
  const agentDisplacementById = new Map<number, number>();
  const wallDisplacementById = new Map<number, number>();
  for (const agent of orderedAgents) {
    const position = requirePosition(initialPositions, agent.id);
    positions.set(agent.id, [position[0], position[1]]);
    agentDisplacementById.set(agent.id, 0);
    wallDisplacementById.set(agent.id, 0);
  }

  const correctedPairs = new Set<string>();
  const correctedWalls = new Set<string>();
  if (parameters.enabled) {
    for (let iteration = 0; iteration < parameters.iterations; iteration += 1) {
      const pairContributions = zeroVectors(orderedAgents);
      for (let firstIndex = 0; firstIndex < orderedAgents.length; firstIndex += 1) {
        const first = orderedAgents[firstIndex];
        const firstPosition = requirePosition(positions, first.id);
        for (let secondIndex = firstIndex + 1; secondIndex < orderedAgents.length; secondIndex += 1) {
          const second = orderedAgents[secondIndex];
          const secondPosition = requirePosition(positions, second.id);
          const delta = sub(firstPosition, secondPosition);
          const distance = norm(delta);
          const requiredDistance = first.radius + second.radius + parameters.padding;
          const penetration = requiredDistance - distance;
          if (penetration <= 0) continue;
          const direction =
            distance > CORRECTION_DIRECTION_EPSILON_METERS
              ? scale(delta, 1 / distance)
              : deterministicPairDirection(first.id, second.id);
          const displacement = scale(direction, penetration / 2);
          pairContributions.set(first.id, add(requirePosition(pairContributions, first.id), displacement));
          pairContributions.set(second.id, sub(requirePosition(pairContributions, second.id), displacement));
          correctedPairs.add(`${first.id}:${second.id}`);
        }
      }
      applyContributions(orderedAgents, positions, pairContributions, agentDisplacementById);

      const wallContributions = zeroVectors(orderedAgents);
      for (const agent of orderedAgents) {
        const position = requirePosition(positions, agent.id);
        for (const wall of orderedWalls) {
          const closest = closestPointOnSegment(position, wall.start, wall.end);
          const offset = sub(position, closest);
          const distance = norm(offset);
          const requiredDistance = agent.radius + wall.thickness / 2 + parameters.padding;
          const penetration = requiredDistance - distance;
          if (penetration <= 0) continue;
          const direction =
            distance > CORRECTION_DIRECTION_EPSILON_METERS
              ? scale(offset, 1 / distance)
              : deterministicWallNormal(agent.id, wall);
          wallContributions.set(
            agent.id,
            add(requirePosition(wallContributions, agent.id), scale(direction, penetration)),
          );
          correctedWalls.add(`${agent.id}:${wall.id}`);
        }
      }
      applyContributions(orderedAgents, positions, wallContributions, wallDisplacementById);
    }
  }

  const totalAgentCorrectionDisplacement = sumValues(agentDisplacementById);
  const totalWallCorrectionDisplacement = sumValues(wallDisplacementById);
  return {
    positions,
    agentDisplacementById,
    wallDisplacementById,
    correctedAgentPairs: correctedPairs.size,
    correctedWallContacts: correctedWalls.size,
    totalAgentCorrectionDisplacement,
    totalWallCorrectionDisplacement,
  };
}

function zeroVectors(agents: readonly AgentState[]): Map<number, Vec2> {
  return new Map(agents.map((agent) => [agent.id, [0, 0] as Vec2]));
}

function applyContributions(
  agents: readonly AgentState[],
  positions: Map<number, Vec2>,
  contributions: PositionMap,
  distanceTotals: Map<number, number>,
): void {
  for (const agent of agents) {
    const displacement = requirePosition(contributions, agent.id);
    positions.set(agent.id, add(requirePosition(positions, agent.id), displacement));
    distanceTotals.set(agent.id, (distanceTotals.get(agent.id) ?? 0) + norm(displacement));
  }
}

function deterministicPairDirection(firstId: number, secondId: number): Vec2 {
  const hash = stableHash(firstId, secondId);
  const angle = (hash / 0x1_0000_0000) * 2 * Math.PI;
  return [Math.cos(angle), Math.sin(angle)];
}

function deterministicWallNormal(agentId: number, wall: WallSegment): Vec2 {
  const tangent = sub(wall.end, wall.start);
  let normal: Vec2;
  try {
    const unitTangent = normalize(tangent, 0);
    normal = [-unitTangent[1], unitTangent[0]];
  } catch {
    const angle = (stableHash(agentId, wall.id) / 0x1_0000_0000) * 2 * Math.PI;
    return [Math.cos(angle), Math.sin(angle)];
  }
  return (stableHash(agentId, wall.id) & 1) === 0 ? normal : scale(normal, -1);
}

function stableHash(first: number, second: number): number {
  let value = Math.imul(first ^ 0x9e3779b9, 0x85ebca6b);
  value ^= Math.imul(second ^ 0xc2b2ae35, 0x27d4eb2f);
  value ^= value >>> 16;
  return value >>> 0;
}

function sumValues(values: ReadonlyMap<number, number>): number {
  let total = 0;
  for (const value of values.values()) total += value;
  return total;
}
