import {
  CONTROLLER_ID,
  EUCLIDEAN_GOAL_CONTROLLER_ID,
  type ScientificControllerParameters,
} from "../../src/core/types";
import { requireFiniteNumber, validateControllerParameters } from "../../src/core/validation";
import { requireStrictObject } from "./validation";

export const METHOD_CONFIG_VERSION_1 = 1 as const;
export const METHOD_CONFIG_VERSION = METHOD_CONFIG_VERSION_1;

export const SCIENTIFIC_CORE_ENGINE_ID = "scientific_core_engine_v1" as const;

interface ScientificMethodConfigBase {
  methodConfigVersion: typeof METHOD_CONFIG_VERSION_1;
  velocityTimeConstant: number;
}

export interface RiemannianMethodConfig extends ScientificMethodConfigBase {
  id: typeof CONTROLLER_ID;
  parameters: {
    alpha: number;
    sigma: number;
    lambdaR: number;
    lambdaT: number;
  };
}

export interface EuclideanGoalMethodConfig extends ScientificMethodConfigBase {
  id: typeof EUCLIDEAN_GOAL_CONTROLLER_ID;
  parameters: Record<string, never>;
}

export type ScientificMethodConfig = RiemannianMethodConfig | EuclideanGoalMethodConfig;
export type MethodConfig = ScientificMethodConfig;

export function parseMethodConfig(value: unknown): MethodConfig {
  const candidate = requireStrictObject(value, "methodConfig", [
    "methodConfigVersion",
    "id",
    "velocityTimeConstant",
    "parameters",
  ]);
  if (candidate.methodConfigVersion !== METHOD_CONFIG_VERSION_1) {
    throw new Error(`Unsupported methodConfigVersion: ${String(candidate.methodConfigVersion)}`);
  }
  return parseScientificMethod(candidate);
}

function parseScientificMethod(root: Record<string, unknown>): ScientificMethodConfig {
  const strict = requireStrictObject(root, "methodConfig", [
    "methodConfigVersion",
    "id",
    "velocityTimeConstant",
    "parameters",
  ]);
  const velocityTimeConstant = requireFiniteNumber(
    strict.velocityTimeConstant,
    "methodConfig.velocityTimeConstant",
  );
  if (velocityTimeConstant < 0) {
    throw new Error("methodConfig.velocityTimeConstant must be nonnegative");
  }

  if (strict.id === CONTROLLER_ID) {
    const parametersValue = requireStrictObject(strict.parameters, "methodConfig.parameters", [
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
      methodConfigVersion: METHOD_CONFIG_VERSION_1,
      id: CONTROLLER_ID,
      velocityTimeConstant,
      parameters,
    };
  }
  if (strict.id === EUCLIDEAN_GOAL_CONTROLLER_ID) {
    requireStrictObject(strict.parameters, "methodConfig.parameters", []);
    return {
      methodConfigVersion: METHOD_CONFIG_VERSION_1,
      id: EUCLIDEAN_GOAL_CONTROLLER_ID,
      velocityTimeConstant,
      parameters: {},
    };
  }
  throw new Error(`Unsupported version-1 method id: ${String(strict.id)}`);
}

export function isScientificMethod(method: MethodConfig): method is ScientificMethodConfig {
  return method.methodConfigVersion === METHOD_CONFIG_VERSION_1;
}

export function engineIdForMethod(_method: MethodConfig): string {
  return SCIENTIFIC_CORE_ENGINE_ID;
}

export function velocityTimeConstantForMethod(method: MethodConfig): number | null {
  return method.velocityTimeConstant;
}

export function controllerParametersFromMethod(
  method: MethodConfig,
): ScientificControllerParameters {
  if (method.id === CONTROLLER_ID) return { id: CONTROLLER_ID, ...method.parameters };
  return { id: EUCLIDEAN_GOAL_CONTROLLER_ID };
}
