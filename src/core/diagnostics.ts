import { closestPointOnSegment, norm, sub } from "./math";
import type { AgentState, ContactMeasurements, Vec2, WallSegment } from "./types";

export type PositionMap = ReadonlyMap<number, Vec2>;

/** Measures physical overlap; correction padding is deliberately not counted as penetration. */
export function measureContacts(
  agents: readonly AgentState[],
  walls: readonly WallSegment[],
  positions: PositionMap,
): ContactMeasurements {
  const orderedAgents = [...agents].sort((a, b) => a.id - b.id);
  const orderedWalls = [...walls].sort((a, b) => a.id - b.id);
  let overlapPairs = 0;
  let wallContacts = 0;
  let maxAgentPenetration = 0;
  let maxWallPenetration = 0;
  let totalAgentPenetration = 0;
  let totalWallPenetration = 0;
  let minimumClearance: number | null = null;
  let minimumAgentClearance: number | null = null;
  let minimumWallClearance: number | null = null;

  for (let firstIndex = 0; firstIndex < orderedAgents.length; firstIndex += 1) {
    const first = orderedAgents[firstIndex];
    const firstPosition = requirePosition(positions, first.id);
    for (let secondIndex = firstIndex + 1; secondIndex < orderedAgents.length; secondIndex += 1) {
      const second = orderedAgents[secondIndex];
      const clearance = norm(sub(firstPosition, requirePosition(positions, second.id))) - first.radius - second.radius;
      minimumAgentClearance =
        minimumAgentClearance === null ? clearance : Math.min(minimumAgentClearance, clearance);
      minimumClearance = minimumClearance === null ? clearance : Math.min(minimumClearance, clearance);
      const penetration = Math.max(0, -clearance);
      if (penetration > 0) overlapPairs += 1;
      maxAgentPenetration = Math.max(maxAgentPenetration, penetration);
      totalAgentPenetration += penetration;
    }

    for (const wall of orderedWalls) {
      const closest = closestPointOnSegment(firstPosition, wall.start, wall.end);
      const clearance = norm(sub(firstPosition, closest)) - first.radius - wall.thickness / 2;
      minimumWallClearance =
        minimumWallClearance === null ? clearance : Math.min(minimumWallClearance, clearance);
      minimumClearance = minimumClearance === null ? clearance : Math.min(minimumClearance, clearance);
      const penetration = Math.max(0, -clearance);
      if (penetration > 0) wallContacts += 1;
      maxWallPenetration = Math.max(maxWallPenetration, penetration);
      totalWallPenetration += penetration;
    }
  }

  return {
    overlapPairs,
    wallContacts,
    maxAgentPenetration,
    maxWallPenetration,
    totalAgentPenetration,
    totalWallPenetration,
    minimumClearance,
    minimumAgentClearance,
    minimumWallClearance,
  };
}

export function requirePosition(positions: PositionMap, id: number): Vec2 {
  const position = positions.get(id);
  if (position === undefined) throw new Error(`Missing position for agent ${id}`);
  return position;
}
