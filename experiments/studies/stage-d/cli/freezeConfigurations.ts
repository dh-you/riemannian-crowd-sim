import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createExperimentEngine } from "../../../engines/factory";
import { sha256File } from "../../../protocol/hash";
import { identifyMethod } from "../../../protocol/methodIdentity";
import { parseMethodConfig, type MethodConfig } from "../../../protocol/methodConfig";
import { parseExperimentScenario } from "../../../protocol/schema";
import { readBuildManifest, readThirdPartyLock } from "../../../baselines/common/thirdParty";
import { readCandidateManifest } from "../candidates";
import type { SelectionManifest } from "./selectConfigurations";
import { materializeFrozenTestScenarios } from "../testScenarios";
import {
  RESULTS_ROOT,
  STUDY_ROOT,
  currentGitHead,
  git,
  phaseManifestPath,
  planFileHashes,
  readJson,
  verifyPreregisteredPlan,
  writeJson,
} from "../studyPaths";

export const FREEZE_MANIFEST_PATH = resolve(STUDY_ROOT, "freeze-manifest.json");
export const FROZEN_METHOD_ROOT = resolve("experiments/methods/frozen/stage-d");

export interface FrozenMethodRecord {
  methodId: string;
  methodKey: string;
  path: string;
  methodConfigCanonicalSha256: string;
  methodConfigSourceSha256: string;
  engineId: string;
  engineAdapterVersion: string;
  upstreamCommit: string | null;
  upstreamLicense: string | null;
  thirdPartyLockSha256: string | null;
  buildManifestSha256: string | null;
  runnerSha256: string | null;
}

export interface FreezeManifest {
  freezeManifestVersion: 1;
  status: "FROZEN";
  preregistrationCommit: string;
  repositoryShaBeforeFreeze: string;
  planHashes: Record<string, string>;
  d0ReportSha256: string;
  humanReviewSha256: string;
  scenarioSuiteSha256: string;
  selectionCodeSha256: string;
  candidateSpaceSha256: string;
  selectionManifestSha256: string;
  validationPhaseManifestHashes: Record<string, string>;
  thirdPartyLockSha256: string;
  baselineBuildManifestSha256: string;
  upstreamCommits: Record<string, string>;
  frozenMethods: FrozenMethodRecord[];
  testScenarios: ReturnType<typeof materializeFrozenTestScenarios>;
  expectedTestRunCount: number;
  testMetricPolicySha256: string;
  statisticsPolicy: { bootstrapSeed: number; bootstrapReplicates: number; confidenceLevel: number };
  runtimePolicy: { populationSizes: number[]; horizonSeconds: number; warmups: number; repetitions: number };
  creationTimestamp: string;
}

export function freezeConfigurations(): FreezeManifest {
  const plan = verifyPreregisteredPlan();
  const selection = readJson<SelectionManifest>(phaseManifestPath("selection"));
  if (selection.status !== "PASS") throw new Error("Selection manifest is not passing");
  const candidates = readCandidateManifest();
  mkdirSync(FROZEN_METHOD_ROOT, { recursive: true });
  const frozenSources: Array<{ path: string; source: string; config: MethodConfig }> = [];
  const filenames: Record<string, string> = {
    conditioned_riemannian_metric_v1: "conditioned-riemannian.json",
    orca_rvo2_v1: "orca-rvo2.json",
    social_force_pysocialforce_v1: "pysocialforce.json",
  };
  for (const [methodId, selected] of Object.entries(selection.selected)) {
    const candidate = candidates.candidates.find(({ candidateId, methodKey }) =>
      candidateId === selected.candidateId && methodKey === selected.methodKey);
    if (candidate === undefined || candidate.methodId !== methodId) {
      throw new Error(`Selected candidate identity is missing for ${methodId}`);
    }
    const path = resolve(FROZEN_METHOD_ROOT, filenames[methodId]);
    copyFileSync(candidate.path, path);
    const source = readFileSync(path, "utf8");
    frozenSources.push({ path, source, config: parseMethodConfig(JSON.parse(source) as unknown) });
  }
  const selectedRiemannian = frozenSources.find(({ config }) =>
    config.id === "conditioned_riemannian_metric_v1")?.config;
  if (selectedRiemannian === undefined || selectedRiemannian.methodConfigVersion !== 1) {
    throw new Error("Selected Riemannian configuration is absent");
  }
  const goalConfig = parseMethodConfig({
    methodConfigVersion: 1,
    id: "euclidean_goal_steering_v1",
    velocityTimeConstant: selectedRiemannian.velocityTimeConstant,
    parameters: {},
  });
  const goalPath = resolve(FROZEN_METHOD_ROOT, "goal-projection.json");
  const goalSource = `${JSON.stringify(goalConfig, null, 2)}\n`;
  writeFileSync(goalPath, goalSource, "utf8");
  frozenSources.push({ path: goalPath, source: goalSource, config: goalConfig });

  const holdoutScenarioManifest = readJson<{ scenarios: { path: string }[] }>(
    resolve(RESULTS_ROOT, "scenarios/validationHoldout/scenario-manifest.json"),
  );
  const provenanceScenario = parseExperimentScenario(JSON.parse(readFileSync(
    holdoutScenarioManifest.scenarios[0].path,
    "utf8",
  )) as unknown);
  const frozenMethods = frozenSources.map(({ path, source, config }): FrozenMethodRecord => {
    const identity = identifyMethod(config, source);
    const engine = createExperimentEngine(config, identity);
    const provenance = engine.getProvenance(provenanceScenario, config);
    return {
      methodId: config.id,
      methodKey: identity.methodKey,
      path,
      methodConfigCanonicalSha256: identity.methodConfigCanonicalSha256,
      methodConfigSourceSha256: identity.methodConfigSourceSha256,
      engineId: provenance.engineId,
      engineAdapterVersion: provenance.engineAdapterVersion,
      upstreamCommit: provenance.upstreamCommit,
      upstreamLicense: provenance.upstreamLicense,
      thirdPartyLockSha256: provenance.thirdPartyLockSha256,
      buildManifestSha256: provenance.buildManifestSha256,
      runnerSha256: provenance.runnerSha256,
    };
  }).sort((first, second) => first.methodId.localeCompare(second.methodId));
  if (new Set(frozenMethods.map(({ methodId }) => methodId)).size !== 4) {
    throw new Error("Freeze must contain exactly four distinct headline methods");
  }
  const goal = frozenSources.find(({ config }) => config.id === "euclidean_goal_steering_v1")?.config;
  if (goal === undefined || goal.methodConfigVersion !== 1
    || goal.velocityTimeConstant !== selectedRiemannian.velocityTimeConstant) {
    throw new Error("Goal+Projection does not share selected Riemannian smoothing");
  }
  const testScenarios = materializeFrozenTestScenarios();
  const lock = readThirdPartyLock();
  const build = readBuildManifest();
  if (build.lockSha256 !== plan.provenance.thirdPartyLockSha256) {
    throw new Error("Baseline build manifest does not match the preregistered third-party lock");
  }
  const preregistrationCommit = git([
    "log",
    "--format=%H",
    "--grep=^Preregister Stage D evaluation plan$",
    "-1",
  ]);
  if (!/^[a-f0-9]{40}$/u.test(preregistrationCommit)) {
    throw new Error("Cannot identify the preregistration commit");
  }
  const manifest: FreezeManifest = {
    freezeManifestVersion: 1,
    status: "FROZEN",
    preregistrationCommit,
    repositoryShaBeforeFreeze: currentGitHead(),
    planHashes: planFileHashes(),
    d0ReportSha256: plan.provenance.d0ReportSha256,
    humanReviewSha256: plan.provenance.humanReviewSha256,
    scenarioSuiteSha256: plan.provenance.scenarioSuiteSha256,
    selectionCodeSha256: sha256File(resolve(STUDY_ROOT, "selection.ts")),
    candidateSpaceSha256: plan.lockedPlanInputs.candidateSpaceSha256,
    selectionManifestSha256: sha256File(phaseManifestPath("selection")),
    validationPhaseManifestHashes: Object.fromEntries([
      "screening",
      "validation-tuning",
      "validation-holdout",
    ].map((phase) => [phase, sha256File(phaseManifestPath(phase))])),
    thirdPartyLockSha256: plan.provenance.thirdPartyLockSha256,
    baselineBuildManifestSha256: plan.provenance.baselineBuildManifestSha256,
    upstreamCommits: Object.fromEntries(lock.dependencies.map(({ id, commit }) => [id, commit])),
    frozenMethods,
    testScenarios,
    expectedTestRunCount: testScenarios.length * frozenMethods.length,
    testMetricPolicySha256: plan.lockedPlanInputs.metricPolicySha256,
    statisticsPolicy: plan.statisticsPolicy,
    runtimePolicy: { populationSizes: [50, 100, 200], horizonSeconds: 10, warmups: 1, repetitions: 5 },
    creationTimestamp: new Date().toISOString(),
  };
  if (manifest.expectedTestRunCount !== 1160) throw new Error("Frozen test run count is not 1160");
  writeJson(FREEZE_MANIFEST_PATH, manifest);
  return manifest;
}

function main(): void {
  try {
    const manifest = freezeConfigurations();
    console.log(`study:d:freeze materialized ${manifest.frozenMethods.length} methods and ${manifest.testScenarios.length} untouched test scenarios`);
  } catch (error) {
    console.error(`study:d:freeze failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) main();
