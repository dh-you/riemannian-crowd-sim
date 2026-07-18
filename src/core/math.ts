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
    throw new Error("Expected a symmetric 2x2 matrix");
  }
  const offDiagonal = 0.5 * (matrix.xy + matrix.yx);
  const det = matrix.xx * matrix.yy - offDiagonal * offDiagonal;
  const matrixScale = Math.max(1, Math.abs(matrix.xx), Math.abs(offDiagonal), Math.abs(matrix.yy));
  if (!Number.isFinite(det) || det <= NUMERICAL_EPSILON * matrixScale * matrixScale) {
    throw new Error("Symmetric 2x2 solve failed: matrix is singular or not positive definite");
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

function canonicalZero(value: number): number {
  return value === 0 ? 0 : value;
}
