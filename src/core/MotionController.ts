import type { AgentState, Vec2 } from "./types";

export interface MotionControllerResult {
  targetVelocity: Vec2;
  /** Whether the controlled agent begins this step inside the goal disk. */
  arrived: boolean;
  coincidentNeighborContributionsSkipped: number;
}

/** Shared target-velocity contract used by the synchronous scientific simulator. */
export interface MotionController {
  readonly id: string;
  readonly interactionRadius: number;

  computeControl(
    controlled: AgentState,
    neighbors: readonly AgentState[],
    goalTolerance: number,
  ): MotionControllerResult;
}
