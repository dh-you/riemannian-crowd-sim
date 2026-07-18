import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const REPOSITORY_ROOT = resolve(".");
export const AUDIT_RESULTS_ROOT = resolve("results", "stage-d0-audit");

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function runPython(script: string, arguments_: readonly string[]): void {
  const executable = process.platform === "win32" ? "python" : "python3";
  const result = spawnSync(executable, [resolve(script), ...arguments_], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.stdout.trim().length > 0) console.log(result.stdout.trim());
  if (result.status !== 0) {
    const detail = result.stderr.trim().length > 0 ? result.stderr.trim() : result.stdout.trim();
    throw new Error(`${script} exited ${String(result.status)}${detail.length > 0 ? `: ${detail}` : ""}`);
  }
}

export function containsNonFinite(value: unknown): boolean {
  if (typeof value === "number") return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some(containsNonFinite);
  if (value !== null && typeof value === "object") {
    return Object.values(value).some(containsNonFinite);
  }
  return false;
}
