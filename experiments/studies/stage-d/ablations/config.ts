import { sha256Bytes } from "../../../protocol/hash";
import { createMethodKey } from "../../../protocol/methodIdentity";
import { requireFiniteNumber, validateControllerParameters } from "../../../../src/core/validation";
import { requireStrictObject } from "../../../protocol/validation";

export const RIEMANNIAN_ABLATION_METHOD_ID = "riemannian_ablation_v1" as const;
export const RIEMANNIAN_ABLATION_ENGINE_ID = "scientific_core_ablation_engine_v1" as const;
export const RIEMANNIAN_ABLATION_CONFIG_VERSION = 1 as const;

export interface RiemannianAblationConfig {
  ablationMethodConfigVersion: typeof RIEMANNIAN_ABLATION_CONFIG_VERSION;
  id: typeof RIEMANNIAN_ABLATION_METHOD_ID;
  engine: typeof RIEMANNIAN_ABLATION_ENGINE_ID;
  velocityTimeConstant: number;
  parameters: {
    alpha: number;
    sigma: number;
    lambdaR: number;
    lambdaT: number;
  };
  gates: {
    closing: boolean;
    visibility: boolean;
  };
}

export interface RiemannianAblationIdentity {
  methodIdentityVersion: 2;
  methodId: typeof RIEMANNIAN_ABLATION_METHOD_ID;
  methodKey: string;
  methodConfigCanonicalSha256: string;
  methodConfigSourceSha256: string;
  methodConfigCanonicalJson: string;
}

export function parseRiemannianAblationConfig(value: unknown): RiemannianAblationConfig {
  const root = requireStrictObject(value, "ablationMethodConfig", [
    "ablationMethodConfigVersion",
    "id",
    "engine",
    "velocityTimeConstant",
    "parameters",
    "gates",
  ]);
  if (root.ablationMethodConfigVersion !== RIEMANNIAN_ABLATION_CONFIG_VERSION) {
    throw new Error(
      `Unsupported ablationMethodConfigVersion: ${String(root.ablationMethodConfigVersion)}`,
    );
  }
  if (root.id !== RIEMANNIAN_ABLATION_METHOD_ID) {
    throw new Error(`Unsupported ablation method ID: ${String(root.id)}`);
  }
  if (root.engine !== RIEMANNIAN_ABLATION_ENGINE_ID) {
    throw new Error(`${RIEMANNIAN_ABLATION_METHOD_ID} requires engine ${RIEMANNIAN_ABLATION_ENGINE_ID}`);
  }
  const velocityTimeConstant = requireFiniteNumber(
    root.velocityTimeConstant,
    "ablationMethodConfig.velocityTimeConstant",
  );
  if (velocityTimeConstant < 0) {
    throw new Error("ablationMethodConfig.velocityTimeConstant must be nonnegative");
  }
  const rawParameters = requireStrictObject(root.parameters, "ablationMethodConfig.parameters", [
    "alpha",
    "sigma",
    "lambdaR",
    "lambdaT",
  ]);
  const parameters = {
    alpha: requireFiniteNumber(rawParameters.alpha, "ablationMethodConfig.parameters.alpha"),
    sigma: requireFiniteNumber(rawParameters.sigma, "ablationMethodConfig.parameters.sigma"),
    lambdaR: requireFiniteNumber(rawParameters.lambdaR, "ablationMethodConfig.parameters.lambdaR"),
    lambdaT: requireFiniteNumber(rawParameters.lambdaT, "ablationMethodConfig.parameters.lambdaT"),
  };
  validateControllerParameters({ id: "conditioned_riemannian_metric_v1", ...parameters });
  const rawGates = requireStrictObject(root.gates, "ablationMethodConfig.gates", [
    "closing",
    "visibility",
  ]);
  if (typeof rawGates.closing !== "boolean" || typeof rawGates.visibility !== "boolean") {
    throw new Error("ablationMethodConfig gates must be boolean");
  }
  return {
    ablationMethodConfigVersion: RIEMANNIAN_ABLATION_CONFIG_VERSION,
    id: RIEMANNIAN_ABLATION_METHOD_ID,
    engine: RIEMANNIAN_ABLATION_ENGINE_ID,
    velocityTimeConstant,
    parameters,
    gates: { closing: rawGates.closing, visibility: rawGates.visibility },
  };
}

export function serializeCanonicalRiemannianAblationConfig(
  config: RiemannianAblationConfig,
): string {
  return `${JSON.stringify({
    ablationMethodConfigVersion: config.ablationMethodConfigVersion,
    id: config.id,
    engine: config.engine,
    velocityTimeConstant: config.velocityTimeConstant,
    parameters: {
      alpha: config.parameters.alpha,
      lambdaR: config.parameters.lambdaR,
      lambdaT: config.parameters.lambdaT,
      sigma: config.parameters.sigma,
    },
    gates: {
      closing: config.gates.closing,
      visibility: config.gates.visibility,
    },
  })}\n`;
}

export function identifyRiemannianAblationConfig(
  config: RiemannianAblationConfig,
  source: string | Buffer,
): RiemannianAblationIdentity {
  const canonical = serializeCanonicalRiemannianAblationConfig(config);
  const canonicalSha256 = sha256Bytes(canonical);
  return {
    methodIdentityVersion: 2,
    methodId: RIEMANNIAN_ABLATION_METHOD_ID,
    methodKey: createMethodKey(RIEMANNIAN_ABLATION_METHOD_ID, canonicalSha256),
    methodConfigCanonicalSha256: canonicalSha256,
    methodConfigSourceSha256: sha256Bytes(source),
    methodConfigCanonicalJson: canonical,
  };
}
