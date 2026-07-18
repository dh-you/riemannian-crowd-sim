import { norm, sub } from "../../../src/core/math";
import type { Vec2, WallSegment } from "../../../src/core/types";

export interface ExpandedWallPolygon {
  wallId: number;
  /** Counterclockwise rectangle vertices around the wall centerline. */
  vertices: readonly [Vec2, Vec2, Vec2, Vec2];
}

export function expandThickWalls(walls: readonly WallSegment[]): ExpandedWallPolygon[] {
  return [...walls].sort((a, b) => a.id - b.id).map(expandThickWall);
}

export function expandThickWall(wall: WallSegment): ExpandedWallPolygon {
  const delta = sub(wall.end, wall.start);
  const length = norm(delta);
  if (!Number.isFinite(length) || length <= 1e-12) {
    throw new Error(`Wall ${wall.id} has a degenerate segment`);
  }
  if (!Number.isFinite(wall.thickness) || wall.thickness <= 0) {
    throw new Error(`Wall ${wall.id} must have positive thickness for baseline expansion`);
  }
  const tangent: Vec2 = [delta[0] / length, delta[1] / length];
  const normal: Vec2 = [-tangent[1], tangent[0]];
  const half = wall.thickness / 2;
  const offset: Vec2 = [normal[0] * half, normal[1] * half];
  const vertices: [Vec2, Vec2, Vec2, Vec2] = [
    [wall.start[0] - offset[0], wall.start[1] - offset[1]],
    [wall.end[0] - offset[0], wall.end[1] - offset[1]],
    [wall.end[0] + offset[0], wall.end[1] + offset[1]],
    [wall.start[0] + offset[0], wall.start[1] + offset[1]],
  ];
  const twiceArea = vertices.reduce((sum, point, index) => {
    const next = vertices[(index + 1) % vertices.length];
    return sum + point[0] * next[1] - point[1] * next[0];
  }, 0);
  if (!(twiceArea > 0)) throw new Error(`Wall ${wall.id} expansion is not counterclockwise`);
  return { wallId: wall.id, vertices };
}
