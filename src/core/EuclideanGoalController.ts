import { isFiniteVec2, norm, scale, sub } from "./math";
import type { MotionController, MotionControllerResult } from "./MotionController";
import { EUCLIDEAN_GOAL_CONTROLLER_ID, type AgentState } from "./types";

/** Neighbor-independent Euclidean goal steering used as the Goal+Projection control. */
export class EuclideanGoalController implements MotionController {
  readonly id = EUCLIDEAN_GOAL_CONTROLLER_ID;
  readonly interactionRadius = 0;

  computeControl(
    controlled: AgentState,
    _neighbors: readonly AgentState[],
    goalTolerance: number,
  ): MotionControllerResult {
    if (!Number.isFinite(goalTolerance) || goalTolerance < 0) {
      throw new Error("Goal tolerance must be finite and nonnegative");
    }
    const goalOffset = sub(controlled.goal, controlled.position);
    const distance = norm(goalOffset);
    if (distance <= goalTolerance) {
      return {
        targetVelocity: [0, 0],
        arrived: true,
        coincidentNeighborContributionsSkipped: 0,
      };
    }
    const targetVelocity = scale(goalOffset, controlled.preferredSpeed / distance);
    if (!isFiniteVec2(targetVelocity)) {
      throw new Error(`Euclidean target velocity for agent ${controlled.id} is non-finite`);
    }
    return {
      targetVelocity,
      arrived: false,
      coincidentNeighborContributionsSkipped: 0,
    };
  }
}
