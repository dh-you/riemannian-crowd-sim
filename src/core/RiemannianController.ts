import {
  addMat2,
  dot,
  identityMat2,
  isFiniteVec2,
  matVec,
  norm,
  normalize,
  quadraticForm,
  scale,
  scaleMat2,
  solveSymmetric2x2,
  sub,
} from "./math";
import { smoothstep, wendlandC2 } from "./smoothstep";
import type { AgentState, ControllerParameters, Mat2, Vec2 } from "./types";
import { validateControllerParameters } from "./validation";

/** Below this physical separation, anisotropic neighbor tensors are undefined and skipped. */
export const COINCIDENT_NEIGHBOR_EPSILON_METERS = 1e-9;

export interface EffectiveMetricResult {
  metric: Mat2;
  coincidentNeighborContributionsSkipped: number;
}

export interface TargetVelocityResult {
  targetVelocity: Vec2;
  arrived: boolean;
}

export function anisotropicTensor(radialDirection: Vec2, lambdaR: number, lambdaT: number): Mat2 {
  if (![lambdaR, lambdaT].every(Number.isFinite) || lambdaR <= 0 || lambdaT <= 0) {
    throw new Error("Anisotropic tensor eigenvalues must be finite and positive");
  }
  const radial = normalize(radialDirection);
  const delta = lambdaR - lambdaT;
  const xy = delta * radial[0] * radial[1];
  return {
    xx: lambdaT + delta * radial[0] * radial[0],
    xy,
    yx: xy,
    yy: lambdaT + delta * radial[1] * radial[1],
  };
}

export function closingGate(controlled: AgentState, neighbor: AgentState, radialDirection: Vec2): number {
  const signedDistanceRate = dot(radialDirection, sub(neighbor.velocity, controlled.velocity));
  return smoothstep(0, controlled.preferredSpeed, -signedDistanceRate);
}

export function visibilityGate(controlled: AgentState, radialDirection: Vec2): number {
  const goalOffset = sub(controlled.goal, controlled.position);
  const goalDistance = norm(goalOffset);
  if (goalDistance === 0) return 0;
  const heading = scale(goalOffset, 1 / goalDistance);
  return smoothstep(-1, 1, dot(heading, radialDirection));
}

export function riemannianSpeed(velocity: Vec2, metric: Mat2): number {
  const squared = quadraticForm(velocity, metric);
  if (!Number.isFinite(squared) || squared < 0) {
    throw new Error("Riemannian norm is not finite and nonnegative");
  }
  return Math.sqrt(squared);
}

export class RiemannianController {
  readonly parameters: ControllerParameters;

  constructor(parameters: ControllerParameters) {
    validateControllerParameters(parameters);
    this.parameters = { ...parameters };
  }

  computeEffectiveMetric(controlled: AgentState, neighbors: readonly AgentState[]): EffectiveMetricResult {
    let metric = identityMat2();
    let skipped = 0;
    const orderedNeighbors = [...neighbors].sort((a, b) => a.id - b.id);
    for (const neighbor of orderedNeighbors) {
      if (neighbor.id === controlled.id) continue;
      const relative = sub(neighbor.position, controlled.position);
      const distance = norm(relative);
      if (distance >= this.parameters.sigma) continue;
      if (distance < COINCIDENT_NEIGHBOR_EPSILON_METERS) {
        skipped += 1;
        continue;
      }
      const radial = scale(relative, 1 / distance);
      const weight =
        this.parameters.alpha *
        wendlandC2(distance / this.parameters.sigma) *
        closingGate(controlled, neighbor, radial) *
        visibilityGate(controlled, radial);
      if (weight === 0) continue;
      const tensor = anisotropicTensor(radial, this.parameters.lambdaR, this.parameters.lambdaT);
      metric = addMat2(metric, scaleMat2(tensor, weight));
    }
    if (![metric.xx, metric.xy, metric.yx, metric.yy].every(Number.isFinite)) {
      throw new Error(`Effective metric for agent ${controlled.id} is non-finite`);
    }
    return { metric, coincidentNeighborContributionsSkipped: skipped };
  }

  computeTargetVelocity(agent: AgentState, metric: Mat2, goalTolerance: number): TargetVelocityResult {
    if (!Number.isFinite(goalTolerance) || goalTolerance < 0) {
      throw new Error("Goal tolerance must be finite and nonnegative");
    }
    const goalOffset = sub(agent.goal, agent.position);
    if (norm(goalOffset) <= goalTolerance) {
      return { targetVelocity: [0, 0], arrived: true };
    }
    const gradient = scale(sub(agent.position, agent.goal), 2);
    const solved = solveSymmetric2x2(metric, gradient);
    const normalizationSquared = dot(gradient, solved);
    if (!Number.isFinite(normalizationSquared) || normalizationSquared <= 0) {
      throw new Error(`Invalid inverse-metric normalization for agent ${agent.id}`);
    }
    const targetVelocity = scale(solved, -agent.preferredSpeed / Math.sqrt(normalizationSquared));
    if (!isFiniteVec2(targetVelocity) || !isFiniteVec2(matVec(metric, targetVelocity))) {
      throw new Error(`Target velocity for agent ${agent.id} is non-finite`);
    }
    return { targetVelocity, arrived: false };
  }
}
