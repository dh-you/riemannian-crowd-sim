import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runExperiment } from "../../../cli/runExperiment";
import { RunMetricsAccumulator } from "../../../metrics/RunMetricsAccumulator";
import type { RunMetrics } from "../../../metrics/types";
import { sha256Bytes, sha256File } from "../../../protocol/hash";
import { identifyMethod } from "../../../protocol/methodIdentity";
import { parseMethodConfig } from "../../../protocol/methodConfig";
import { parseExperimentScenario } from "../../../protocol/schema";
import { readCandidateManifest } from "../candidates";
import {
  identifyRiemannianAblationConfig,
  parseRiemannianAblationConfig,
  type RiemannianAblationConfig,
} from "../ablations/config";
import { runRiemannianAblation } from "../ablations/RiemannianAblationEngine";
import type { PhaseManifest } from "../phaseRunner";
import type { SelectionManifest } from "./selectConfigurations";
import {
  RESULTS_ROOT,
  currentGitHead,
  phaseManifestPath,
  planFileHashes,
  readJson,
  verifyPreregisteredPlan,
  writeJson,
} from "../studyPaths";

type AblationName = "full" | "isotropic" | "no_closing" | "no_visibility" | "no_conditioning" | "goal_projection";

interface AblationRun {
  ablation: AblationName;
  scenarioId: string;
  scenarioSha256: string;
  methodKey: string;
  metricsPath: string;
}

interface AblationManifest {
  ablationManifestVersion: 1;
  status: "PASS";
  repositoryCommit: string;
  planHashes: Record<string, string>;
  selectionManifestSha256: string;
  selectedRiemannianCandidateId: string;
  scenarioCount: number;
  ablations: AblationName[];
  expectedRunCount: number;
  runs: AblationRun[];
  fullModeParityMaximumAbsoluteDifference: number;
}

export function runAblations(): AblationManifest {
  verifyPreregisteredPlan();
  const selectionPath = phaseManifestPath("selection");
  const selection = readJson<SelectionManifest>(selectionPath);
  if (selection.status !== "PASS") throw new Error("Selection must pass before ablations");
  const selected = selection.selected.conditioned_riemannian_metric_v1;
  if (selected === undefined) throw new Error("Selected Riemannian candidate is missing");
  const candidate = readCandidateManifest().candidates.find(({ candidateId, methodKey }) =>
    candidateId === selected.candidateId && methodKey === selected.methodKey);
  if (candidate === undefined) throw new Error("Selected Riemannian config cannot be located");
  const selectedSource = readFileSync(candidate.path, "utf8");
  const selectedConfig = parseMethodConfig(JSON.parse(selectedSource) as unknown);
  if (selectedConfig.id !== "conditioned_riemannian_metric_v1") {
    throw new Error("Selected ablation reference is not Conditioned Riemannian");
  }
  const phase = readJson<PhaseManifest>(phaseManifestPath("validation-holdout"));
  if (phase.status !== "PASS") throw new Error("Validation holdout is not complete");
  const scenarioManifest = readJson<{ scenarios: Array<{ scenarioId: string; path: string; sha256: string }> }>(
    resolve(RESULTS_ROOT, "scenarios/validationHoldout/scenario-manifest.json"),
  );
  const names: AblationName[] = [
    "full",
    "isotropic",
    "no_closing",
    "no_visibility",
    "no_conditioning",
    "goal_projection",
  ];
  const configs = new Map<AblationName, RiemannianAblationConfig>();
  const base = {
    ablationMethodConfigVersion: 1 as const,
    id: "riemannian_ablation_v1" as const,
    engine: "scientific_core_ablation_engine_v1" as const,
    velocityTimeConstant: selectedConfig.velocityTimeConstant,
    parameters: { ...selectedConfig.parameters },
  };
  configs.set("full", parseRiemannianAblationConfig({ ...base, gates: { closing: true, visibility: true } }));
  configs.set("isotropic", parseRiemannianAblationConfig({
    ...base,
    parameters: { ...base.parameters, lambdaR: 1, lambdaT: 1 },
    gates: { closing: true, visibility: true },
  }));
  configs.set("no_closing", parseRiemannianAblationConfig({ ...base, gates: { closing: false, visibility: true } }));
  configs.set("no_visibility", parseRiemannianAblationConfig({ ...base, gates: { closing: true, visibility: false } }));
  configs.set("no_conditioning", parseRiemannianAblationConfig({ ...base, gates: { closing: false, visibility: false } }));
  const goalConfig = parseMethodConfig({
    methodConfigVersion: 1,
    id: "euclidean_goal_steering_v1",
    velocityTimeConstant: selectedConfig.velocityTimeConstant,
    parameters: {},
  });
  const goalSource = `${JSON.stringify(goalConfig, null, 2)}\n`;
  const goalConfigPath = resolve(RESULTS_ROOT, "ablations/configs/goal_projection.json");
  mkdirSync(dirname(goalConfigPath), { recursive: true });
  writeFileSync(goalConfigPath, goalSource, "utf8");

  const runs: AblationRun[] = [];
  let maximumParityDifference = 0;
  for (const scenarioRecord of scenarioManifest.scenarios) {
    const scenarioSource = readFileSync(scenarioRecord.path, "utf8");
    if (sha256Bytes(scenarioSource) !== scenarioRecord.sha256) throw new Error("Holdout scenario hash mismatch");
    const scenario = parseExperimentScenario(JSON.parse(scenarioSource) as unknown);
    for (const name of names) {
      if (name === "goal_projection") {
        const identity = identifyMethod(goalConfig, goalSource);
        const output = resolve(RESULTS_ROOT, "ablations/runs", scenarioRecord.scenarioId, name);
        const result = existsSync(resolve(output, "run-metrics.json"))
          ? { metricsPath: resolve(output, "run-metrics.json"), metrics: readJson<RunMetrics>(resolve(output, "run-metrics.json")) }
          : runExperiment({
              scenarioPath: scenarioRecord.path,
              methodPath: goalConfigPath,
              outputDirectory: output,
              recordingInterval: 1_000_000_000,
              commandArguments: ["study:d:ablations", name, scenarioRecord.scenarioId],
            });
        if (result.metrics.identity.methodKey !== identity.methodKey) throw new Error("Goal ablation identity mismatch");
        runs.push({
          ablation: name,
          scenarioId: scenarioRecord.scenarioId,
          scenarioSha256: scenarioRecord.sha256,
          methodKey: identity.methodKey,
          metricsPath: result.metricsPath,
        });
        continue;
      }
      const config = configs.get(name);
      if (config === undefined) throw new Error(`Missing ablation config: ${name}`);
      const configSource = `${JSON.stringify(config, null, 2)}\n`;
      const identity = identifyRiemannianAblationConfig(config, configSource);
      const output = resolve(RESULTS_ROOT, "ablations/runs", scenarioRecord.scenarioId, name);
      const metricsPath = resolve(output, "run-metrics.json");
      let metrics: RunMetrics;
      if (existsSync(metricsPath)) {
        metrics = readJson<RunMetrics>(metricsPath);
        if (metrics.identity.methodKey !== identity.methodKey) throw new Error("Ablation resume identity mismatch");
      } else {
        const accumulator = new RunMetricsAccumulator(scenario, {
          methodId: config.id,
          methodKey: identity.methodKey,
          methodIdentityVersion: identity.methodIdentityVersion,
          methodConfigCanonicalSha256: identity.methodConfigCanonicalSha256,
          methodConfigSourceSha256: identity.methodConfigSourceSha256,
          methodConfigSha256: identity.methodConfigCanonicalSha256,
          engineId: config.engine,
          engineAdapterVersion: "1",
          correctionMode: scenario.simulation.correction.enabled ? "shared_projection" : "disabled",
          commandVelocityMeaning: "ablation controller target velocity before Scientific Core smoothing",
          upstreamProject: null,
          upstreamCommit: null,
          upstreamLicense: null,
          velocityTimeConstant: config.velocityTimeConstant,
          methodParameters: {
            ...config.parameters,
            closingGateEnabled: config.gates.closing ? 1 : 0,
            visibilityGateEnabled: config.gates.visibility ? 1 : 0,
          },
        });
        const result = runRiemannianAblation(scenario, config, (record) => accumulator.observeStep(record));
        metrics = accumulator.finish(result.finalStates);
        writeJson(metricsPath, metrics);
        writeJson(resolve(output, "manifest.json"), {
          ablationRunManifestVersion: 1,
          ablation: name,
          repositoryCommit: currentGitHead(),
          scenarioId: scenarioRecord.scenarioId,
          scenarioSha256: scenarioRecord.sha256,
          methodKey: identity.methodKey,
          methodConfigCanonicalSha256: identity.methodConfigCanonicalSha256,
          methodConfigSourceSha256: identity.methodConfigSourceSha256,
          engineId: config.engine,
          correctionMode: scenario.simulation.correction.enabled ? "shared_projection" : "disabled",
        });
      }
      if (containsNonFinite(metrics)) throw new Error(`Non-finite ${name} metrics`);
      if (name === "full") {
        const productionRun = phase.completedRuns.find((run) =>
          run.candidateId === selected.candidateId && run.scenarioId === scenarioRecord.scenarioId);
        if (productionRun === undefined) throw new Error("Full-mode production parity run is missing");
        const production = readJson<RunMetrics>(productionRun.metricsPath);
        maximumParityDifference = Math.max(
          maximumParityDifference,
          maximumNumericDifference(stripIdentity(metrics), stripIdentity(production)),
        );
      }
      runs.push({
        ablation: name,
        scenarioId: scenarioRecord.scenarioId,
        scenarioSha256: scenarioRecord.sha256,
        methodKey: identity.methodKey,
        metricsPath,
      });
    }
  }
  if (runs.length !== scenarioManifest.scenarios.length * names.length) {
    throw new Error("Ablation Cartesian product is incomplete");
  }
  if (maximumParityDifference > 1e-12) {
    throw new Error(`Full ablation mode differs from production by ${maximumParityDifference}`);
  }
  const manifest: AblationManifest = {
    ablationManifestVersion: 1,
    status: "PASS",
    repositoryCommit: currentGitHead(),
    planHashes: planFileHashes(),
    selectionManifestSha256: sha256File(selectionPath),
    selectedRiemannianCandidateId: selected.candidateId,
    scenarioCount: scenarioManifest.scenarios.length,
    ablations: names,
    expectedRunCount: scenarioManifest.scenarios.length * names.length,
    runs,
    fullModeParityMaximumAbsoluteDifference: maximumParityDifference,
  };
  writeJson(phaseManifestPath("ablations"), manifest);
  return manifest;
}

function stripIdentity(metrics: RunMetrics): unknown {
  const record: Partial<RunMetrics> = { ...metrics };
  delete record.identity;
  return record;
}

function maximumNumericDifference(first: unknown, second: unknown): number {
  if (typeof first === "number" && typeof second === "number") return Math.abs(first - second);
  if (first === null || second === null || typeof first !== typeof second) return first === second ? 0 : Infinity;
  if (Array.isArray(first) && Array.isArray(second)) {
    if (first.length !== second.length) return Infinity;
    return Math.max(0, ...first.map((value, index) => maximumNumericDifference(value, second[index])));
  }
  if (first !== null && second !== null && typeof first === "object" && typeof second === "object") {
    const firstRecord = first as Record<string, unknown>;
    const secondRecord = second as Record<string, unknown>;
    const keys = Object.keys(firstRecord);
    if (keys.length !== Object.keys(secondRecord).length) return Infinity;
    return Math.max(0, ...keys.map((key) => maximumNumericDifference(firstRecord[key], secondRecord[key])));
  }
  return first === second ? 0 : Infinity;
}

function containsNonFinite(value: unknown): boolean {
  if (typeof value === "number") return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some(containsNonFinite);
  if (value !== null && typeof value === "object") return Object.values(value).some(containsNonFinite);
  return false;
}

function main(): void {
  try {
    const manifest = runAblations();
    console.log(`study:d:ablations PASS: ${manifest.runs.length} holdout runs; full parity ${manifest.fullModeParityMaximumAbsoluteDifference}`);
  } catch (error) {
    console.error(`study:d:ablations failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) main();
