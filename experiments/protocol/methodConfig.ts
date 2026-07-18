import {
  CONTROLLER_ID,
  EUCLIDEAN_GOAL_CONTROLLER_ID,
  type ScientificControllerParameters,
} from "../../src/core/types";
import { requireFiniteNumber, validateControllerParameters } from "../../src/core/validation";
import { requireStrictObject } from "./validation";

export const METHOD_CONFIG_VERSION = 1 as const;

interface MethodConfigBase {
  methodConfigVersion: typeof METHOD_CONFIG_VERSION;
  velocityTimeConstant: number;
}

export interface RiemannianMethodConfig extends MethodConfigBase {
  id: typeof CONTROLLER_ID;
  parameters: {
    alpha: number;
    sigma: number;
    lambdaR: number;
    lambdaT: number;
  };
}

export interface EuclideanGoalMethodConfig extends MethodConfigBase {
  id: typeof EUCLIDEAN_GOAL_CONTROLLER_ID;
  parameters: Record<string, never>;
}

export type MethodConfig = RiemannianMethodConfig | EuclideanGoalMethodConfig;

export function parseMethodConfig(value: unknown): MethodConfig {
  const root = requireStrictObject(value, "methodConfig", [
    "methodConfigVersion",
    "id",
    "velocityTimeConstant",
    "parameters",
  ]);
  if (root.methodConfigVersion !== METHOD_CONFIG_VERSION) {
    throw new Error(`Unsupported methodConfigVersion: ${String(root.methodConfigVersion)}`);
  }
  const velocityTimeConstant = requireFiniteNumber(
    root.velocityTimeConstant,
    "methodConfig.velocityTimeConstant",
  );
  if (velocityTimeConstant < 0) {
    throw new Error("methodConfig.velocityTimeConstant must be nonnegative");
  }

  if (root.id === CONTROLLER_ID) {
    const parametersValue = requireStrictObject(root.parameters, "methodConfig.parameters", [
      "alpha",
      "sigma",
      "lambdaR",
      "lambdaT",
    ]);
    const parameters = {
      alpha: requireFiniteNumber(parametersValue.alpha, "methodConfig.parameters.alpha"),
      sigma: requireFiniteNumber(parametersValue.sigma, "methodConfig.parameters.sigma"),
      lambdaR: requireFiniteNumber(parametersValue.lambdaR, "methodConfig.parameters.lambdaR"),
      lambdaT: requireFiniteNumber(parametersValue.lambdaT, "methodConfig.parameters.lambdaT"),
    };
    validateControllerParameters({ id: CONTROLLER_ID, ...parameters });
    return {
      methodConfigVersion: METHOD_CONFIG_VERSION,
      id: CONTROLLER_ID,
      velocityTimeConstant,
      parameters,
    };
  }
  if (root.id === EUCLIDEAN_GOAL_CONTROLLER_ID) {
    requireStrictObject(root.parameters, "methodConfig.parameters", []);
    return {
      methodConfigVersion: METHOD_CONFIG_VERSION,
      id: EUCLIDEAN_GOAL_CONTROLLER_ID,
      velocityTimeConstant,
      parameters: {},
    };
  }
  throw new Error(`Unsupported method controller id: ${String(root.id)}`);
}

export function controllerParametersFromMethod(
  method: MethodConfig,
): ScientificControllerParameters {
  if (method.id === CONTROLLER_ID) return { id: CONTROLLER_ID, ...method.parameters };
  return { id: EUCLIDEAN_GOAL_CONTROLLER_ID };
}
