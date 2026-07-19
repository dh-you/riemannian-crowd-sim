import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createExperimentEngine } from "../../engines/factory";
import { validateEngineStepRecord } from "../../engines/engineStep";
import { RunMetricsAccumulator } from "../../metrics/RunMetricsAccumulator";
import { sha256Bytes } from "../../protocol/hash";
import { identifyMethod } from "../../protocol/methodIdentity";
import { parseMethodConfig, velocityTimeConstantForMethod } from "../../protocol/methodConfig";
import { parseExperimentScenario } from "../../protocol/schema";
import { containsNonFinite, writeJson } from "./runUtils";

export interface AuditRunResult {
  outputDirectory: string;
  manifestPath: string;
  trajectoryPath: string;
  metricsPath: string;
  summaryPath: string;
}

export function runAuditedEngine(
  scenarioSourcePath: string,
  methodSourcePath: string,
  outputDirectorySource: string,
): AuditRunResult {
  const scenarioPath = resolve(scenarioSourcePath);
  const methodPath = resolve(methodSourcePath);
  const outputDirectory = resolve(outputDirectorySource);
  mkdirSync(outputDirectory, { recursive: true });
  const scenarioBytes = readFileSync(scenarioPath, "utf8");
  const methodBytes = readFileSync(methodPath, "utf8");
  const scenario = parseExperimentScenario(JSON.parse(scenarioBytes) as unknown);
  const method = parseMethodConfig(JSON.parse(methodBytes) as unknown);
  const identity = identifyMethod(method, methodBytes);
  const engine = createExperimentEngine(method, identity);
  const provenance = engine.getProvenance(scenario, method);
  const accumulator = new RunMetricsAccumulator(scenario, {
    methodId: method.id,
    methodKey: identity.methodKey,
    methodIdentityVersion: identity.methodIdentityVersion,
    methodConfigCanonicalSha256: identity.methodConfigCanonicalSha256,
    methodConfigSourceSha256: identity.methodConfigSourceSha256,
    methodConfigSha256: identity.methodConfigCanonicalSha256,
    velocityTimeConstant: velocityTimeConstantForMethod(method),
    methodParameters: method.parameters,
    engineId: provenance.engineId,
    engineAdapterVersion: provenance.engineAdapterVersion,
    correctionMode: provenance.correctionMode,
    commandVelocityMeaning: provenance.commandVelocityMeaning,
    upstreamProject: provenance.upstreamProject,
    upstreamCommit: provenance.upstreamCommit,
    upstreamLicense: provenance.upstreamLicense,
  });
  const trajectoryPath = resolve(outputDirectory, "engine-steps.jsonl");
  const descriptor = openSync(trajectoryPath, "w");
  let engineResult;
  try {
    engineResult = engine.run(scenario, method, identity, (record) => {
      validateEngineStepRecord(record);
      accumulator.observeStep(record);
      writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
    });
  } finally {
    closeSync(descriptor);
  }
  const metrics = accumulator.finish(engineResult.finalStates);
  if (containsNonFinite(metrics) || containsNonFinite(engineResult.finalStates)) {
    throw new Error(`Audit run produced a non-finite value for ${method.id}`);
  }
  const manifest = {
    auditRunManifestVersion: 1,
    scenarioPath,
    methodPath,
    scenarioSha256: sha256Bytes(scenarioBytes),
    scenarioName: scenario.name,
    expectedStepCount: scenario.simulation.horizonSeconds / scenario.simulation.dt,
    actualStepCount: engineResult.totalSteps,
    methodId: method.id,
    methodIdentityVersion: identity.methodIdentityVersion,
    methodKey: identity.methodKey,
    methodConfigCanonicalSha256: identity.methodConfigCanonicalSha256,
    methodConfigSourceSha256: identity.methodConfigSourceSha256,
    engineId: provenance.engineId,
    engineAdapterVersion: provenance.engineAdapterVersion,
    correctionMode: provenance.correctionMode,
    commandVelocityMeaning: provenance.commandVelocityMeaning,
    thirdPartyLockSha256: provenance.thirdPartyLockSha256,
    upstreamProject: provenance.upstreamProject,
    upstreamRepository: provenance.upstreamRepository,
    upstreamCommit: provenance.upstreamCommit,
    upstreamLicense: provenance.upstreamLicense,
    runnerPath: provenance.runnerPath,
    runnerSha256: provenance.runnerSha256,
    buildManifestSha256: provenance.buildManifestSha256,
    limitations: provenance.limitations,
  };
  const summary = {
    totalSteps: engineResult.totalSteps,
    finalStates: engineResult.finalStates,
  };
  const manifestPath = resolve(outputDirectory, "audit-manifest.json");
  const metricsPath = resolve(outputDirectory, "run-metrics.json");
  const summaryPath = resolve(outputDirectory, "summary.json");
  writeJson(manifestPath, manifest);
  writeJson(metricsPath, metrics);
  writeJson(summaryPath, summary);
  return { outputDirectory, manifestPath, trajectoryPath, metricsPath, summaryPath };
}
