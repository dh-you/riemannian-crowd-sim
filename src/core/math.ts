import type { Mat2, Vec2 } from "./types";

export const NUMERICAL_EPSILON = 1e-12;

export function vec(x: number, y: number): Vec2 {
  return [canonicalZero(x), canonicalZero(y)];
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return [canonicalZero(a[0] + b[0]), canonicalZero(a[1] + b[1])];
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return [canonicalZero(a[0] - b[0]), canonicalZero(a[1] - b[1])];
}

export function scale(v: Vec2, scalar: number): Vec2 {
  return [canonicalZero(v[0] * scalar), canonicalZero(v[1] * scalar)];
}

export function dot(a: Vec2, b: Vec2): number {
  return a[0] * b[0] + a[1] * b[1];
}

export function normSquared(v: Vec2): number {
  return dot(v, v);
}

export function norm(v: Vec2): number {
  return Math.hypot(v[0], v[1]);
}

export function normalize(v: Vec2, epsilon = NUMERICAL_EPSILON): Vec2 {
  const length = norm(v);
  if (!Number.isFinite(length) || length <= epsilon) {
    throw new Error("Cannot normalize a non-finite or near-zero vector");
  }
  return scale(v, 1 / length);
}

export function isFiniteVec2(v: Vec2): boolean {
  return Number.isFinite(v[0]) && Number.isFinite(v[1]);
}

export function identityMat2(): Mat2 {
  return { xx: 1, xy: 0, yx: 0, yy: 1 };
}

export function addMat2(a: Mat2, b: Mat2): Mat2 {
  return {
    xx: a.xx + b.xx,
    xy: a.xy + b.xy,
    yx: a.yx + b.yx,
    yy: a.yy + b.yy,
  };
}

export function scaleMat2(matrix: Mat2, scalar: number): Mat2 {
  return {
    xx: matrix.xx * scalar,
    xy: matrix.xy * scalar,
    yx: matrix.yx * scalar,
    yy: matrix.yy * scalar,
  };
}

export function matVec(matrix: Mat2, vector: Vec2): Vec2 {
  return [
    canonicalZero(matrix.xx * vector[0] + matrix.xy * vector[1]),
    canonicalZero(matrix.yx * vector[0] + matrix.yy * vector[1]),
  ];
}

export function quadraticForm(vector: Vec2, matrix: Mat2): number {
  return dot(vector, matVec(matrix, vector));
}

export function determinant(matrix: Mat2): number {
  return matrix.xx * matrix.yy - matrix.xy * matrix.yx;
}

/** Stable direct solve for a finite, symmetric, positive-definite 2x2 matrix. */
export function solveSymmetric2x2(matrix: Mat2, rightHandSide: Vec2): Vec2 {
  const values = [matrix.xx, matrix.xy, matrix.yx, matrix.yy, ...rightHandSide];
  if (!values.every(Number.isFinite)) {
    throw new Error("Cannot solve a system containing non-finite values");
  }
  const symmetryScale = Math.max(1, Math.abs(matrix.xy), Math.abs(matrix.yx));
  if (Math.abs(matrix.xy - matrix.yx) > 1e-12 * symmetryScale) {
    throw new Error(
      "Symmetric 2x2 solve failed: matrix is not symmetric positive definite (symmetry check failed)",
    );
  }
  const offDiagonal = 0.5 * (matrix.xy + matrix.yx);
  const matrixScale = Math.max(1, Math.abs(matrix.xx), Math.abs(offDiagonal), Math.abs(matrix.yy));
  if (matrix.xx <= NUMERICAL_EPSILON * matrixScale) {
    throw new Error(
      "Symmetric 2x2 solve failed: matrix is not symmetric positive definite (leading diagonal is nonpositive or numerically negligible)",
    );
  }
  const det = matrix.xx * matrix.yy - offDiagonal * offDiagonal;
  if (!Number.isFinite(det) || det <= NUMERICAL_EPSILON * matrixScale * matrixScale) {
    throw new Error(
      "Symmetric 2x2 solve failed: matrix is not symmetric positive definite (determinant is nonpositive or numerically negligible)",
    );
  }
  const solution: Vec2 = [
    canonicalZero((matrix.yy * rightHandSide[0] - offDiagonal * rightHandSide[1]) / det),
    canonicalZero((matrix.xx * rightHandSide[1] - offDiagonal * rightHandSide[0]) / det),
  ];
  if (!isFiniteVec2(solution)) {
    throw new Error("Symmetric 2x2 solve produced a non-finite result");
  }
  return solution;
}

export function symmetricEigenvalues(matrix: Mat2): Vec2 {
  const offDiagonal = 0.5 * (matrix.xy + matrix.yx);
  const halfTrace = 0.5 * (matrix.xx + matrix.yy);
  const radius = Math.hypot(0.5 * (matrix.xx - matrix.yy), offDiagonal);
  return [halfTrace - radius, halfTrace + radius];
}

export function closestPointOnSegment(point: Vec2, start: Vec2, end: Vec2): Vec2 {
  const segment = sub(end, start);
  const lengthSquared = normSquared(segment);
  if (!Number.isFinite(lengthSquared) || lengthSquared <= NUMERICAL_EPSILON * NUMERICAL_EPSILON) {
    return [start[0], start[1]];
  }
  const t = Math.max(0, Math.min(1, dot(sub(point, start), segment) / lengthSquared));
  return add(start, scale(segment, t));
}

/**
 * Returns the first point at which a closed segment enters a closed disk.
 * A start point already in the disk is its own first intersection.
 */
export function firstSegmentDiskIntersection(
  start: Vec2,
  end: Vec2,
  center: Vec2,
  radius: number,
): Vec2 | null {
  if (![...start, ...end, ...center, radius].every(Number.isFinite)) {
    throw new Error("Segment-disk intersection requires finite inputs");
  }
  if (radius < 0) throw new Error("Segment-disk radius must be nonnegative");

  const startOffset = sub(start, center);
  const radiusSquared = radius * radius;
  const startDistanceSquared = normSquared(startOffset);
  if (![radiusSquared, startDistanceSquared].every(Number.isFinite)) {
    throw new Error("Segment-disk intersection overflowed its finite input range");
  }
  if (startDistanceSquared <= radiusSquared) return [start[0], start[1]];

  const direction = sub(end, start);
  const a = normSquared(direction);
  if (!Number.isFinite(a)) {
    throw new Error("Segment-disk intersection overflowed its finite input range");
  }
  if (a === 0) return null;

  // Solve a*t^2 + 2*b*t + c = 0 for the earliest t in [0, 1].
  const b = dot(startOffset, direction);
  const c = startDistanceSquared - radiusSquared;
  const discriminant = b * b - a * c;
  if (![b, c, discriminant].every(Number.isFinite)) {
    throw new Error("Segment-disk intersection overflowed its finite input range");
  }
  const discriminantScale = Math.max(1, Math.abs(b * b), Math.abs(a * c));
  if (discriminant < -NUMERICAL_EPSILON * discriminantScale) return null;
  const squareRoot = Math.sqrt(Math.max(0, discriminant));
  const firstRoot = (-b - squareRoot) / a;
  const secondRoot = (-b + squareRoot) / a;
  const parameter = firstParameterOnClosedSegment(firstRoot, secondRoot);
  if (parameter === null) return null;

  const intersection = add(start, scale(direction, parameter));
  if (!isFiniteVec2(intersection)) {
    throw new Error("Segment-disk intersection produced a non-finite result");
  }
  return clampToClosedDisk(intersection, center, radius);
}

function firstParameterOnClosedSegment(first: number, second: number): number | null {
  const parameterTolerance = NUMERICAL_EPSILON;
  for (const parameter of [first, second].sort((a, b) => a - b)) {
    if (parameter >= -parameterTolerance && parameter <= 1 + parameterTolerance) {
      return Math.max(0, Math.min(1, parameter));
    }
  }
  return null;
}

function clampToClosedDisk(point: Vec2, center: Vec2, radius: number): Vec2 {
  const offset = sub(point, center);
  const distance = norm(offset);
  if (distance <= radius || distance === 0) return point;
  return add(center, scale(offset, radius / distance));
}

function canonicalZero(value: number): number {
  return value === 0 ? 0 : value;
}
