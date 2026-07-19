import {
  addMat2,
  identityMat2,
  norm,
  scale,
  scaleMat2,
  sub,
} from "../../../src/core/math";
import type { MotionController, MotionControllerResult } from "../../../src/core/MotionController";
import {
  anisotropicTensor,
  closingGate,
  COINCIDENT_NEIGHBOR_EPSILON_METERS,
  RiemannianController,
  visibilityGate,
  type EffectiveMetricResult,
} from "../../../src/core/RiemannianController";
import { wendlandC2 } from "../../../src/core/smoothstep";
import type { AgentState } from "../../../src/core/types";
import type { RiemannianAblationConfig } from "./config";
import { RIEMANNIAN_ABLATION_METHOD_ID } from "./config";

/** Experiment-only controller used for the lean study's mechanically defined ablations. */
export class RiemannianAblationController implements MotionController {
  readonly id = RIEMANNIAN_ABLATION_METHOD_ID;
  private readonly targetController: RiemannianController;

  constructor(readonly config: RiemannianAblationConfig) {
    this.targetController = new RiemannianController({
      id: "conditioned_riemannian_metric_v1",
      ...config.parameters,
    });
  }

  get interactionRadius(): number {
    return this.config.parameters.sigma;
  }

  computeControl(
    controlled: AgentState,
    neighbors: readonly AgentState[],
    goalTolerance: number,
  ): MotionControllerResult {
    const effective = this.computeEffectiveMetric(controlled, neighbors);
    const target = this.targetController.computeTargetVelocity(
      controlled,
      effective.metric,
      goalTolerance,
    );
    return {
      ...target,
      coincidentNeighborContributionsSkipped: effective.coincidentNeighborContributionsSkipped,
    };
  }

  computeEffectiveMetric(
    controlled: AgentState,
    neighbors: readonly AgentState[],
  ): EffectiveMetricResult {
    let metric = identityMat2();
    let skipped = 0;
    for (const neighbor of [...neighbors].sort((first, second) => first.id - second.id)) {
      if (neighbor.id === controlled.id) continue;
      const relative = sub(neighbor.position, controlled.position);
      const distance = norm(relative);
      if (distance >= this.config.parameters.sigma) continue;
      if (distance < COINCIDENT_NEIGHBOR_EPSILON_METERS) {
        skipped += 1;
        continue;
      }
      const radial = scale(relative, 1 / distance);
      const closing = this.config.gates.closing ? closingGate(controlled, neighbor, radial) : 1;
      const visibility = this.config.gates.visibility ? visibilityGate(controlled, radial) : 1;
      const weight = this.config.parameters.alpha
        * wendlandC2(distance / this.config.parameters.sigma)
        * closing
        * visibility;
      if (weight === 0) continue;
      const tensor = anisotropicTensor(
        radial,
        this.config.parameters.lambdaR,
        this.config.parameters.lambdaT,
      );
      metric = addMat2(metric, scaleMat2(tensor, weight));
    }
    if (![metric.xx, metric.xy, metric.yx, metric.yy].every(Number.isFinite)) {
      throw new Error(`Ablation metric for agent ${controlled.id} is non-finite`);
    }
    return { metric, coincidentNeighborContributionsSkipped: skipped };
  }
}
