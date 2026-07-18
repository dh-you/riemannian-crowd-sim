import { dot, normSquared, sub } from "../../src/core/math";
import type { Vec2 } from "../../src/core/types";

export function constantVelocityTimeToContact(
  relativePosition: Vec2,
  relativeVelocity: Vec2,
  combinedRadius: number,
): number | null {
  if (
    ![...relativePosition, ...relativeVelocity, combinedRadius].every(Number.isFinite) ||
    combinedRadius < 0
  ) {
    return null;
  }
  const c = normSquared(relativePosition) - combinedRadius * combinedRadius;
  if (!Number.isFinite(c)) return null;
  if (c <= 0) return 0;
  const a = normSquared(relativeVelocity);
  if (!Number.isFinite(a) || a <= 1e-16) return null;
  const b = dot(relativePosition, relativeVelocity);
  if (!Number.isFinite(b) || b >= 0) return null;
  const discriminant = b * b - a * c;
  if (!Number.isFinite(discriminant) || discriminant < 0) return null;
  const time = (-b - Math.sqrt(discriminant)) / a;
  return Number.isFinite(time) && time >= 0 ? time : null;
}

export function relativeGeometry(
  firstPosition: Vec2,
  firstVelocity: Vec2,
  secondPosition: Vec2,
  secondVelocity: Vec2,
): { relativePosition: Vec2; relativeVelocity: Vec2 } {
  return {
    relativePosition: sub(secondPosition, firstPosition),
    relativeVelocity: sub(secondVelocity, firstVelocity),
  };
}
