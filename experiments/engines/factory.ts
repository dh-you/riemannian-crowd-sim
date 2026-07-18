import { identifyMethod, type MethodIdentity } from "../protocol/methodIdentity";
import {
  isScientificMethod,
  type MethodConfig,
} from "../protocol/methodConfig";
import type { ExperimentEngine } from "./ExperimentEngine";
import { ScientificCoreEngine } from "./ScientificCoreEngine";
import { OrcaRvo2Engine } from "./OrcaRvo2Engine";
import { PySocialForceEngine } from "./PySocialForceEngine";
import { ORCA_METHOD_ID, SOCIAL_FORCE_METHOD_ID } from "../protocol/methodConfig";

export function createExperimentEngine(
  method: MethodConfig,
  identity: MethodIdentity,
): ExperimentEngine {
  if (isScientificMethod(method)) {
    return new ScientificCoreEngine(method.id, identity.methodKey);
  }
  if (method.id === ORCA_METHOD_ID) return new OrcaRvo2Engine(method.id, identity.methodKey);
  if (method.id === SOCIAL_FORCE_METHOD_ID) return new PySocialForceEngine(method.id, identity.methodKey);
  throw new Error("Unsupported experiment engine");
}

/** Convenience for tests that construct an engine from validated source text. */
export function createIdentifiedEngine(method: MethodConfig, source: string): ExperimentEngine {
  return createExperimentEngine(method, identifyMethod(method, source));
}
