import { requireFiniteNumber } from "../../src/core/validation";

export function requireStrictObject(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  const object = value as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) throw new Error(`${path}.${key} is not allowed`);
  }
  return object;
}

export function requireNonemptyIdentifier(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]*$/u.test(value)) {
    throw new Error(`${path} must be a nonempty lowercase identifier`);
  }
  return value;
}

export function requireNonemptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a nonempty string`);
  }
  return value;
}

export function requireSafeInteger(value: unknown, path: string): number {
  const number = requireFiniteNumber(value, path);
  if (!Number.isSafeInteger(number)) throw new Error(`${path} must be a safe integer`);
  return number;
}
