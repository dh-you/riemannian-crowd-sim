import type { MethodConfig } from "./methodConfig";
import { sha256Bytes } from "./hash";

export const METHOD_IDENTITY_VERSION = 2 as const;
export const METHOD_KEY_HASH_LENGTH = 12;

export interface MethodIdentity {
  methodIdentityVersion: typeof METHOD_IDENTITY_VERSION;
  methodId: MethodConfig["id"];
  methodKey: string;
  methodConfigCanonicalSha256: string;
  methodConfigSourceSha256: string;
  /** @deprecated Stage B alias; equals the canonical SHA-256 in identity version 2. */
  methodConfigSha256: string;
  methodConfigCanonicalJson: string;
}

export function createMethodKey(methodId: string, canonicalSha256: string): string {
  if (!/^[a-f0-9]{64}$/u.test(canonicalSha256)) {
    throw new Error("Method config SHA-256 must be 64 lowercase hexadecimal characters");
  }
  return `${methodId}--${canonicalSha256.slice(0, METHOD_KEY_HASH_LENGTH)}`;
}

/**
 * Version-2 identity hashes validated semantics, not source formatting. Object
 * fields use the order below; parameter names are always lexicographically sorted.
 */
export function canonicalMethodConfig(config: MethodConfig): Record<string, unknown> {
  const parameters = Object.fromEntries(
    Object.entries(config.parameters).sort(([first], [second]) => first.localeCompare(second)),
  );
  if (config.methodConfigVersion === 1) {
    return {
      methodConfigVersion: config.methodConfigVersion,
      id: config.id,
      velocityTimeConstant: config.velocityTimeConstant,
      parameters,
    };
  }
  return {
    methodConfigVersion: config.methodConfigVersion,
    id: config.id,
    engine: config.engine,
    parameters,
  };
}

export function serializeCanonicalMethodConfig(config: MethodConfig): string {
  return `${JSON.stringify(canonicalMethodConfig(config))}\n`;
}

export function identifyMethod(
  config: MethodConfig,
  configBytes: string | Buffer,
): MethodIdentity {
  const methodConfigCanonicalJson = serializeCanonicalMethodConfig(config);
  const methodConfigCanonicalSha256 = sha256Bytes(methodConfigCanonicalJson);
  const methodConfigSourceSha256 = sha256Bytes(configBytes);
  return {
    methodIdentityVersion: METHOD_IDENTITY_VERSION,
    methodId: config.id,
    methodKey: createMethodKey(config.id, methodConfigCanonicalSha256),
    methodConfigCanonicalSha256,
    methodConfigSourceSha256,
    methodConfigSha256: methodConfigCanonicalSha256,
    methodConfigCanonicalJson,
  };
}
