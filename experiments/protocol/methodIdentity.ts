import type { MethodConfig } from "./methodConfig";
import { sha256Bytes } from "./hash";

export const METHOD_KEY_HASH_LENGTH = 12;

export interface MethodIdentity {
  methodId: MethodConfig["id"];
  methodKey: string;
  methodConfigSha256: string;
}

export function createMethodKey(controllerId: string, methodConfigSha256: string): string {
  if (!/^[a-f0-9]{64}$/u.test(methodConfigSha256)) {
    throw new Error("Method config SHA-256 must be 64 lowercase hexadecimal characters");
  }
  return `${controllerId}--${methodConfigSha256.slice(0, METHOD_KEY_HASH_LENGTH)}`;
}

export function identifyMethod(
  config: MethodConfig,
  configBytes: string | Buffer,
): MethodIdentity {
  const methodConfigSha256 = sha256Bytes(configBytes);
  return {
    methodId: config.id,
    methodKey: createMethodKey(config.id, methodConfigSha256),
    methodConfigSha256,
  };
}
