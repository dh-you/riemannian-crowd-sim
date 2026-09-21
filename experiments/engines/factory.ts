import { identifyMethod, type MethodIdentity } from "../protocol/methodIdentity";
import {
  isScientificMethod,
  type MethodConfig,
} from "../protocol/methodConfig";
import type { ExperimentEngine } from "./ExperimentEngine";
import { ScientificCoreEngine } from "./ScientificCoreEngine";

export function createExperimentEngine(
  method: MethodConfig,
  identity: MethodIdentity,
): ExperimentEngine {
  if (isScientificMethod(method)) {
    return new ScientificCoreEngine(method.id, identity.methodKey);
  }
  throw new Error("Unsupported experiment engine");
}

/** Convenience for tests that construct an engine from validated source text. */
export function createIdentifiedEngine(method: MethodConfig, source: string): ExperimentEngine {
  return createExperimentEngine(method, identifyMethod(method, source));
}
