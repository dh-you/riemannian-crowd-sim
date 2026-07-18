import { EuclideanGoalController } from "./EuclideanGoalController";
import type { MotionController } from "./MotionController";
import { RiemannianController } from "./RiemannianController";
import {
  CONTROLLER_ID,
  EUCLIDEAN_GOAL_CONTROLLER_ID,
  type ScientificControllerParameters,
} from "./types";
import { validateScientificControllerParameters } from "./validation";

export function createMotionController(parameters: ScientificControllerParameters): MotionController {
  validateScientificControllerParameters(parameters);
  switch (parameters.id) {
    case CONTROLLER_ID:
      return new RiemannianController(parameters);
    case EUCLIDEAN_GOAL_CONTROLLER_ID:
      return new EuclideanGoalController();
  }
}

export function controllerLabel(id: string): string {
  switch (id) {
    case CONTROLLER_ID:
      return "Conditioned Riemannian";
    case EUCLIDEAN_GOAL_CONTROLLER_ID:
      return "Goal+Projection";
    default:
      throw new Error(`Unsupported controller id: ${id}`);
  }
}
