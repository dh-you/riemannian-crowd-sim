import type { Vec2 } from "../../../src/core/types";
import type { ExperimentScenario } from "../../protocol/schema";
import { sha256Bytes } from "../../protocol/hash";
import { expandThickWalls } from "../common/wallGeometry";

export const JUPEDSIM_GEOMETRY_MARGIN_METERS = 5;

export interface JuPedSimGeometrySpec {
  geometrySpecVersion: 1;
  margin: number;
  outerPolygon: [Vec2, Vec2, Vec2, Vec2];
  excludedWallPolygons: Array<{
    wallId: number;
    vertices: [Vec2, Vec2, Vec2, Vec2];
  }>;
}

export interface CanonicalJuPedSimGeometry {
  spec: JuPedSimGeometrySpec;
  canonicalJson: string;
  sha256: string;
}

export function createJuPedSimGeometry(
  scenario: Pick<ExperimentScenario, "agents" | "walls" | "navigation">,
): CanonicalJuPedSimGeometry {
  const excludedWallPolygons = expandThickWalls(scenario.walls).map((polygon) => ({
    wallId: polygon.wallId,
    vertices: polygon.vertices.map(copyVector) as [Vec2, Vec2, Vec2, Vec2],
  }));
  const points: Vec2[] = scenario.agents.flatMap((agent) => [
    copyVector(agent.position),
    copyVector(agent.goal),
  ]);
  if (scenario.navigation.type === "waypoint_then_point_goal") {
    points.push(copyVector(scenario.navigation.waypoint));
  }
  for (const polygon of excludedWallPolygons) points.push(...polygon.vertices.map(copyVector));
  if (points.length === 0) throw new Error("JuPedSim geometry requires at least one relevant point");
  const minimumX = Math.min(...points.map((point) => point[0])) - JUPEDSIM_GEOMETRY_MARGIN_METERS;
  const maximumX = Math.max(...points.map((point) => point[0])) + JUPEDSIM_GEOMETRY_MARGIN_METERS;
  const minimumY = Math.min(...points.map((point) => point[1])) - JUPEDSIM_GEOMETRY_MARGIN_METERS;
  const maximumY = Math.max(...points.map((point) => point[1])) + JUPEDSIM_GEOMETRY_MARGIN_METERS;
  const outerPolygon: [Vec2, Vec2, Vec2, Vec2] = [
    [minimumX, minimumY],
    [maximumX, minimumY],
    [maximumX, maximumY],
    [minimumX, maximumY],
  ];
  const spec: JuPedSimGeometrySpec = {
    geometrySpecVersion: 1,
    margin: JUPEDSIM_GEOMETRY_MARGIN_METERS,
    outerPolygon,
    excludedWallPolygons,
  };
  const canonicalJson = JSON.stringify(sortObjectKeys(spec));
  return { spec, canonicalJson, sha256: sha256Bytes(canonicalJson) };
}

function copyVector(vector: Vec2): Vec2 {
  return [vector[0], vector[1]];
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([first], [second]) => first.localeCompare(second))
        .map(([key, entry]) => [key, sortObjectKeys(entry)]),
    );
  }
  return value;
}
