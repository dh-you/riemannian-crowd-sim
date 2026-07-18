import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { EngineStepRecord } from "../../engines/engineStep";
import { validateEngineStepRecord } from "../../engines/engineStep";
import { forEachJsonLineSync } from "../../protocol/jsonLines";
import { sha256Bytes, sha256File } from "../../protocol/hash";
import { AUDIT_RESULTS_ROOT, containsNonFinite, writeJson } from "./auditUtils";
import { runAuditedEngine } from "./auditRun";

const METHODS = [
  "experiments/methods/riemannian-default.json",
  "experiments/methods/goal-projection.json",
  "experiments/methods/orca-default.json",
  "experiments/methods/social-force-default.json",
] as const;

interface AuditManifest {
  scenarioSha256: string;
  expectedStepCount: number;
  actualStepCount: number;
  methodId: string;
  methodIdentityVersion: number;
  methodKey: string;
  methodConfigCanonicalSha256: string;
  methodConfigSourceSha256: string;
  engineId: string;
  correctionMode: string;
  thirdPartyLockSha256: string | null;
  upstreamCommit: string | null;
  upstreamLicense: string | null;
  runnerPath: string | null;
  runnerSha256: string | null;
  buildManifestSha256: string | null;
}

export interface FairnessAuditResult {
  status: "PASS";
  methodCount: number;
  scenarioSha256: string;
  reportPath: string;
}

export function runFairnessAudit(): FairnessAuditResult {
  const scenarioPath = resolve("experiments", "audit", "scenarios", "single-free-space.json");
  const scenarioBytesBefore = readFileSync(scenarioPath);
  const root = resolve(AUDIT_RESULTS_ROOT, "fairness");
  const manifests: AuditManifest[] = [];
  const checks: { id: string; status: "PASS" | "FAIL"; detail?: unknown }[] = [];
  for (const methodPath of METHODS) {
    const methodId = (JSON.parse(readFileSync(methodPath, "utf8")) as { id: string }).id;
    const run = runAuditedEngine(scenarioPath, methodPath, resolve(root, methodId));
    const manifest = JSON.parse(readFileSync(run.manifestPath, "utf8")) as AuditManifest;
    manifests.push(manifest);
    const steps: EngineStepRecord[] = [];
    forEachJsonLineSync(run.trajectoryPath, (line) => steps.push(validateEngineStepRecord(JSON.parse(line) as EngineStepRecord)));
    checks.push({ id: `${methodId}:step-count`, status: steps.length === manifest.expectedStepCount && steps.length === manifest.actualStepCount ? "PASS" : "FAIL", detail: steps.length });
    checks.push({ id: `${methodId}:finite`, status: containsNonFinite(steps) ? "FAIL" : "PASS" });
    checks.push({ id: `${methodId}:identity`, status: manifest.methodIdentityVersion === 2 && manifest.methodConfigCanonicalSha256.length === 64 && manifest.methodConfigSourceSha256.length === 64 ? "PASS" : "FAIL" });
    const expectedEngine = methodId === "conditioned_riemannian_metric_v1" || methodId === "euclidean_goal_steering_v1"
      ? "scientific_core_engine_v1"
      : methodId === "orca_rvo2_v1" ? "orca_rvo2_engine_v1" : "pysocialforce_engine_v1";
    checks.push({ id: `${methodId}:engine`, status: manifest.engineId === expectedEngine ? "PASS" : "FAIL", detail: manifest.engineId });
    if (methodId === "orca_rvo2_v1" || methodId === "social_force_pysocialforce_v1") {
      const runnerMatches = manifest.runnerPath !== null && manifest.runnerSha256 !== null && sha256File(manifest.runnerPath) === manifest.runnerSha256;
      checks.push({ id: `${methodId}:native-none`, status: manifest.correctionMode === "native_none" ? "PASS" : "FAIL" });
      checks.push({ id: `${methodId}:provenance`, status: manifest.upstreamCommit !== null && manifest.upstreamLicense !== null && manifest.thirdPartyLockSha256 !== null && manifest.buildManifestSha256 !== null && runnerMatches ? "PASS" : "FAIL" });
    } else {
      checks.push({ id: `${methodId}:scientific-correction`, status: manifest.correctionMode === "disabled" ? "PASS" : "FAIL", detail: manifest.correctionMode });
    }
  }
  const scenarioBytesAfter = readFileSync(scenarioPath);
  const scenarioHashes = new Set(manifests.map((manifest) => manifest.scenarioSha256));
  const methodKeys = new Set(manifests.map((manifest) => manifest.methodKey));
  checks.push({ id: "scenario-bytes-unchanged", status: Buffer.compare(scenarioBytesBefore, scenarioBytesAfter) === 0 ? "PASS" : "FAIL" });
  checks.push({ id: "scenario-hash-equality", status: scenarioHashes.size === 1 && [...scenarioHashes][0] === sha256Bytes(scenarioBytesBefore) ? "PASS" : "FAIL", detail: [...scenarioHashes] });
  checks.push({ id: "distinct-method-keys", status: methodKeys.size === METHODS.length ? "PASS" : "FAIL", detail: [...methodKeys] });
  const firstFailure = checks.find((entry) => entry.status === "FAIL") ?? null;
  const reportPath = resolve(root, "report.json");
  writeJson(reportPath, { fairnessAuditVersion: 1, status: firstFailure === null ? "PASS" : "FAIL", scenarioSha256: [...scenarioHashes][0] ?? null, methodKeys: [...methodKeys], firstFailure, checks, manifests });
  if (firstFailure !== null) throw new Error(`Fairness audit failed at ${firstFailure.id}; see ${reportPath}`);
  return { status: "PASS", methodCount: METHODS.length, scenarioSha256: [...scenarioHashes][0], reportPath };
}

function main(): void {
  try {
    const result = runFairnessAudit();
    console.log(`fairness audit passed ${result.methodCount} methods with scenario ${result.scenarioSha256}`);
  } catch (error) {
    console.error(`fairness audit failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) main();
