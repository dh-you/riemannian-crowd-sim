import {
  CONTROLLER_ID,
  EUCLIDEAN_GOAL_CONTROLLER_ID,
  type ScientificControllerParameters,
} from "../../src/core/types";
import { requireFiniteNumber, validateControllerParameters } from "../../src/core/validation";
import { requireSafeInteger, requireStrictObject } from "./validation";

export const METHOD_CONFIG_VERSION_1 = 1 as const;
export const METHOD_CONFIG_VERSION_2 = 2 as const;
/** Retained for Stage B callers that create Scientific Core configurations. */
export const METHOD_CONFIG_VERSION = METHOD_CONFIG_VERSION_1;

export const SCIENTIFIC_CORE_ENGINE_ID = "scientific_core_engine_v1" as const;
export const ORCA_METHOD_ID = "orca_rvo2_v1" as const;
export const ORCA_ENGINE_ID = "orca_rvo2_engine_v1" as const;
export const SOCIAL_FORCE_METHOD_ID = "social_force_pysocialforce_v1" as const;
export const SOCIAL_FORCE_ENGINE_ID = "pysocialforce_engine_v1" as const;
export const SOCIAL_FORCE_RADIUS_METHOD_ID = "social_force_pysocialforce_radius_v2" as const;
export const SOCIAL_FORCE_RADIUS_ENGINE_ID = "pysocialforce_radius_engine_v2" as const;

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

export interface OrcaMethodConfig {
  methodConfigVersion: typeof METHOD_CONFIG_VERSION_2;
  id: typeof ORCA_METHOD_ID;
  engine: typeof ORCA_ENGINE_ID;
  parameters: {
    neighborDist: number;
    maxNeighbors: number;
    timeHorizon: number;
    timeHorizonObst: number;
  };
}

/** Names map directly to the pinned PySocialForce TOML sections and keys. */
export interface SocialForceParameters extends Record<string, number> {
  desiredFactor: number;
  relaxationTime: number;
  socialFactor: number;
  lambdaImportance: number;
  gamma: number;
  n: number;
  nPrime: number;
  obstacleFactor: number;
  obstacleSigma: number;
  obstacleThreshold: number;
  maxSpeedMultiplier: number;
  obstacleResolution: number;
}

export interface SocialForceMethodConfig {
  methodConfigVersion: typeof METHOD_CONFIG_VERSION_2;
  id: typeof SOCIAL_FORCE_METHOD_ID;
  engine: typeof SOCIAL_FORCE_ENGINE_ID;
  parameters: SocialForceParameters;
}

export interface RadiusAwareSocialForceMethodConfig {
  methodConfigVersion: typeof METHOD_CONFIG_VERSION_2;
  id: typeof SOCIAL_FORCE_RADIUS_METHOD_ID;
  engine: typeof SOCIAL_FORCE_RADIUS_ENGINE_ID;
  parameters: SocialForceParameters;
}

export type ScientificMethodConfig = RiemannianMethodConfig | EuclideanGoalMethodConfig;
export type ExternalMethodConfig =
  | OrcaMethodConfig
  | SocialForceMethodConfig
  | RadiusAwareSocialForceMethodConfig;
export type MethodConfig = ScientificMethodConfig | ExternalMethodConfig;

export function parseMethodConfig(value: unknown): MethodConfig {
  const candidate = requireStrictObject(value, "methodConfig", [
    "methodConfigVersion",
    "id",
    "engine",
    "velocityTimeConstant",
    "parameters",
  ]);
  if (candidate.methodConfigVersion === METHOD_CONFIG_VERSION_1) {
    return parseScientificMethod(candidate);
  }
  if (candidate.methodConfigVersion === METHOD_CONFIG_VERSION_2) {
    return parseExternalMethod(candidate);
  }
  throw new Error(`Unsupported methodConfigVersion: ${String(candidate.methodConfigVersion)}`);
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

function parseExternalMethod(root: Record<string, unknown>): ExternalMethodConfig {
  const strict = requireStrictObject(root, "methodConfig", [
    "methodConfigVersion",
    "id",
    "engine",
    "parameters",
  ]);
  if (strict.id === ORCA_METHOD_ID) {
    if (strict.engine !== ORCA_ENGINE_ID) {
      throw new Error(`${ORCA_METHOD_ID} requires engine ${ORCA_ENGINE_ID}`);
    }
    const raw = requireStrictObject(strict.parameters, "methodConfig.parameters", [
      "neighborDist",
      "maxNeighbors",
      "timeHorizon",
      "timeHorizonObst",
    ]);
    const parameters = {
      neighborDist: positive(raw.neighborDist, "neighborDist"),
      maxNeighbors: positiveInteger(raw.maxNeighbors, "maxNeighbors"),
      timeHorizon: positive(raw.timeHorizon, "timeHorizon"),
      timeHorizonObst: positive(raw.timeHorizonObst, "timeHorizonObst"),
    };
    return {
      methodConfigVersion: METHOD_CONFIG_VERSION_2,
      id: ORCA_METHOD_ID,
      engine: ORCA_ENGINE_ID,
      parameters,
    };
  }
  if (strict.id === SOCIAL_FORCE_METHOD_ID || strict.id === SOCIAL_FORCE_RADIUS_METHOD_ID) {
    const expectedEngine = strict.id === SOCIAL_FORCE_METHOD_ID
      ? SOCIAL_FORCE_ENGINE_ID
      : SOCIAL_FORCE_RADIUS_ENGINE_ID;
    if (strict.engine !== expectedEngine) {
      throw new Error(`${String(strict.id)} requires engine ${expectedEngine}`);
    }
    const keys = [
      "desiredFactor",
      "relaxationTime",
      "socialFactor",
      "lambdaImportance",
      "gamma",
      "n",
      "nPrime",
      "obstacleFactor",
      "obstacleSigma",
      "obstacleThreshold",
      "maxSpeedMultiplier",
      "obstacleResolution",
    ] as const;
    const raw = requireStrictObject(strict.parameters, "methodConfig.parameters", keys);
    const parameters: SocialForceParameters = {
      desiredFactor: nonnegative(raw.desiredFactor, "desiredFactor"),
      relaxationTime: positive(raw.relaxationTime, "relaxationTime"),
      socialFactor: nonnegative(raw.socialFactor, "socialFactor"),
      lambdaImportance: positive(raw.lambdaImportance, "lambdaImportance"),
      gamma: positive(raw.gamma, "gamma"),
      n: positive(raw.n, "n"),
      nPrime: positive(raw.nPrime, "nPrime"),
      obstacleFactor: nonnegative(raw.obstacleFactor, "obstacleFactor"),
      obstacleSigma: positive(raw.obstacleSigma, "obstacleSigma"),
      obstacleThreshold: nonnegative(raw.obstacleThreshold, "obstacleThreshold"),
      maxSpeedMultiplier: positive(raw.maxSpeedMultiplier, "maxSpeedMultiplier"),
      obstacleResolution: positive(raw.obstacleResolution, "obstacleResolution"),
    };
    return strict.id === SOCIAL_FORCE_METHOD_ID
      ? {
        methodConfigVersion: METHOD_CONFIG_VERSION_2,
        id: SOCIAL_FORCE_METHOD_ID,
        engine: SOCIAL_FORCE_ENGINE_ID,
        parameters,
      }
      : {
        methodConfigVersion: METHOD_CONFIG_VERSION_2,
        id: SOCIAL_FORCE_RADIUS_METHOD_ID,
        engine: SOCIAL_FORCE_RADIUS_ENGINE_ID,
        parameters,
      };
  }
  throw new Error(`Unsupported version-2 method id: ${String(strict.id)}`);
}

function positive(value: unknown, name: string): number {
  const number = requireFiniteNumber(value, `methodConfig.parameters.${name}`);
  if (number <= 0) throw new Error(`methodConfig.parameters.${name} must be positive`);
  return number;
}

function nonnegative(value: unknown, name: string): number {
  const number = requireFiniteNumber(value, `methodConfig.parameters.${name}`);
  if (number < 0) throw new Error(`methodConfig.parameters.${name} must be nonnegative`);
  return number;
}

function positiveInteger(value: unknown, name: string): number {
  const number = requireSafeInteger(value, `methodConfig.parameters.${name}`);
  if (number <= 0) throw new Error(`methodConfig.parameters.${name} must be positive`);
  return number;
}

export function isScientificMethod(method: MethodConfig): method is ScientificMethodConfig {
  return method.methodConfigVersion === METHOD_CONFIG_VERSION_1;
}

export function engineIdForMethod(method: MethodConfig): string {
  return isScientificMethod(method) ? SCIENTIFIC_CORE_ENGINE_ID : method.engine;
}

export function velocityTimeConstantForMethod(method: MethodConfig): number | null {
  return isScientificMethod(method) ? method.velocityTimeConstant : null;
}

export function controllerParametersFromMethod(
  method: MethodConfig,
): ScientificControllerParameters {
  if (!isScientificMethod(method)) {
    throw new Error(`Method ${method.id} is not a Scientific Core controller`);
  }
  if (method.id === CONTROLLER_ID) return { id: CONTROLLER_ID, ...method.parameters };
  return { id: EUCLIDEAN_GOAL_CONTROLLER_ID };
}
