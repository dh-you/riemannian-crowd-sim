import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { runExperiment } from "../../cli/runExperiment";
import type { RunMetrics } from "../../metrics/types";
import { sha256File } from "../../protocol/hash";
import type { CandidateManifestEntry } from "./candidates";
import { readCandidateManifest } from "./candidates";
import { rankCandidates, scoreCandidates, type CandidateRunMetrics } from "./selection";
import { materializeValidationScenarios, type StudyScenarioEntry, type ValidationPhase } from "./scenarios";
import {
  RESULTS_ROOT,
  currentGitHead,
  phaseManifestPath,
  planFileHashes,
  readJson,
  verifyPreregisteredPlan,
  writeJson,
} from "./studyPaths";

export type RunPhase = "screening" | "validation-tuning" | "validation-holdout";

export interface StudyRunRecord {
  candidateId: string;
  methodId: string;
  methodKey: string;
  scenarioId: string;
  scenarioSha256: string;
  manifestPath: string;
  metricsPath: string;
}

export interface PhaseFailure {
  candidateId: string;
  methodId: string;
  methodKey: string;
  scenarioId: string;
  scenarioSha256: string;
  error: string;
  rerun: false;
}

export interface PhaseManifest {
  phaseManifestVersion: 1;
  phase: RunPhase;
  status: "IN_PROGRESS" | "PASS" | "FAIL";
  repositoryCommit: string;
  planHashes: Record<string, string>;
  candidateManifestSha256: string;
  scenarioManifestSha256: string;
  expectedRunCount: number;
  completedRuns: StudyRunRecord[];
  failures: PhaseFailure[];
  invalidCandidateIds: string[];
  selection: Record<string, ReturnType<typeof rankCandidates>>;
  retainedCandidateIds: string[];
}

export function runStudyPhase(
  phase: RunPhase,
  candidateIds?: readonly string[],
): PhaseManifest {
  verifyPreregisteredPlan();
  const candidateManifest = readCandidateManifest();
  const validationPhase = validationPhaseForRunPhase(phase);
  const scenarioManifest = materializeValidationScenarios(validationPhase);
  const candidates = candidateManifest.candidates.filter((candidate) =>
    candidateIds === undefined || candidateIds.includes(candidate.candidateId));
  if (candidates.length === 0) throw new Error(`${phase} has no candidates`);
  if (candidateIds !== undefined && candidates.length !== new Set(candidateIds).size) {
    throw new Error(`${phase} candidate selection contains an unknown or duplicate ID`);
  }
  const manifestPath = phaseManifestPath(phase);
  const expectedRunCount = candidates.length * scenarioManifest.scenarios.length;
  let manifest: PhaseManifest = existsSync(manifestPath)
    ? readJson<PhaseManifest>(manifestPath)
    : {
        phaseManifestVersion: 1,
        phase,
        status: "IN_PROGRESS",
        repositoryCommit: currentGitHead(),
        planHashes: planFileHashes(),
        candidateManifestSha256: sha256File(resolve(RESULTS_ROOT, "candidates/manifest.json")),
        scenarioManifestSha256: sha256File(resolve(RESULTS_ROOT, "scenarios", validationPhase, "scenario-manifest.json")),
        expectedRunCount,
        completedRuns: [],
        failures: [],
        invalidCandidateIds: [],
        selection: {},
        retainedCandidateIds: [],
      };
  verifyPhaseResume(manifest, phase, expectedRunCount);
  if (manifest.status === "PASS") return manifest;
  const completed = new Map(manifest.completedRuns.map((run) => [runKey(run.candidateId, run.scenarioId), run]));
  const invalid = new Set(manifest.invalidCandidateIds);
  for (const candidate of candidates) {
    if (invalid.has(candidate.candidateId)) continue;
    for (const scenario of scenarioManifest.scenarios) {
      const key = runKey(candidate.candidateId, scenario.scenarioId);
      const prior = completed.get(key);
      if (prior !== undefined) {
        validateCompletedRun(prior, candidate, scenario);
        continue;
      }
      const outputDirectory = resolve(
        RESULTS_ROOT,
        "runs",
        phase,
        scenario.scenarioId,
        candidate.methodKey,
      );
      try {
        const result = runExperiment({
          scenarioPath: scenario.path,
          methodPath: candidate.path,
          outputDirectory,
          recordingInterval: 1_000_000_000,
          commandArguments: ["study", phase, candidate.candidateId, scenario.scenarioId],
        });
        if (result.manifest.scenarioSha256 !== scenario.sha256
          || result.manifest.methodKey !== candidate.methodKey
          || result.manifest.methodConfigCanonicalSha256 !== candidate.methodConfigCanonicalSha256
          || result.manifest.methodConfigSourceSha256 !== candidate.methodConfigSourceSha256
          || result.summary.nonFiniteValueOccurred) {
          throw new Error("run provenance or finite-value validation failed");
        }
        const record: StudyRunRecord = {
          candidateId: candidate.candidateId,
          methodId: candidate.methodId,
          methodKey: candidate.methodKey,
          scenarioId: scenario.scenarioId,
          scenarioSha256: scenario.sha256,
          manifestPath: result.manifestPath,
          metricsPath: result.metricsPath,
        };
        manifest.completedRuns.push(record);
        completed.set(key, record);
      } catch (error) {
        manifest.failures.push({
          candidateId: candidate.candidateId,
          methodId: candidate.methodId,
          methodKey: candidate.methodKey,
          scenarioId: scenario.scenarioId,
          scenarioSha256: scenario.sha256,
          error: error instanceof Error ? error.message : String(error),
          rerun: false,
        });
        invalid.add(candidate.candidateId);
        manifest.invalidCandidateIds = [...invalid].sort();
        writeJson(manifestPath, manifest);
        break;
      }
      manifest.completedRuns.sort((first, second) =>
        first.methodId.localeCompare(second.methodId)
        || first.candidateId.localeCompare(second.candidateId)
        || first.scenarioId.localeCompare(second.scenarioId));
      writeJson(manifestPath, manifest);
    }
  }

  manifest.selection = {};
  manifest.retainedCandidateIds = [];
  for (const methodId of [
    "conditioned_riemannian_metric_v1",
    "orca_rvo2_v1",
    "social_force_pysocialforce_v1",
  ]) {
    const validCandidates = candidates.filter((candidate) =>
      candidate.methodId === methodId && !invalid.has(candidate.candidateId));
    if (validCandidates.length === 0) throw new Error(`${phase} has no valid ${methodId} candidates`);
    const runs = loadCandidateRuns(
      manifest.completedRuns.filter((run) => validCandidates.some(({ candidateId }) =>
        candidateId === run.candidateId)),
      scenarioManifest.scenarios,
    );
    for (const candidate of validCandidates) {
      const count = runs.filter((run) => run.candidateId === candidate.candidateId).length;
      if (count !== scenarioManifest.scenarios.length) {
        throw new Error(`${candidate.candidateId} is missing ${phase} runs`);
      }
    }
    const selection = rankCandidates(scoreCandidates(runs));
    manifest.selection[methodId] = selection;
    const retain = phase === "screening" ? 4 : phase === "validation-tuning" ? 2 : 1;
    if (selection.ranked.length < retain) {
      throw new Error(`${phase} cannot retain ${retain} valid ${methodId} candidates`);
    }
    manifest.retainedCandidateIds.push(...selection.ranked.slice(0, retain).map(({ candidateId }) =>
      candidateId));
  }
  manifest.retainedCandidateIds.sort();
  manifest.invalidCandidateIds = [...invalid].sort();
  manifest.status = "PASS";
  writeJson(manifestPath, manifest);
  return manifest;
}

function loadCandidateRuns(
  records: readonly StudyRunRecord[],
  scenarios: readonly StudyScenarioEntry[],
): CandidateRunMetrics[] {
  const scenarioById = new Map(scenarios.map((scenario) => [scenario.scenarioId, scenario]));
  return records.map((record) => {
    const scenario = scenarioById.get(record.scenarioId);
    if (scenario === undefined) throw new Error(`Unknown scenario record: ${record.scenarioId}`);
    const metrics = readJson<RunMetrics>(record.metricsPath);
    if (metrics.identity.methodKey !== record.methodKey
      || metrics.identity.scenarioName.length === 0
      || containsNonFinite(metrics)) {
      throw new Error(`Malformed run metrics: ${record.metricsPath}`);
    }
    return {
      candidateId: record.candidateId,
      methodId: record.methodId,
      methodKey: record.methodKey,
      scenarioId: record.scenarioId,
      family: scenario.family,
      variant: scenario.variant,
      metrics,
    };
  });
}

function validateCompletedRun(
  record: StudyRunRecord,
  candidate: CandidateManifestEntry,
  scenario: StudyScenarioEntry,
): void {
  if (record.methodKey !== candidate.methodKey || record.scenarioSha256 !== scenario.sha256) {
    throw new Error(`Resume identity mismatch for ${record.candidateId}/${record.scenarioId}`);
  }
  if (!existsSync(record.manifestPath) || !existsSync(record.metricsPath)) {
    throw new Error(`Resume output is missing for ${record.candidateId}/${record.scenarioId}`);
  }
  const manifest = readJson<{
    scenarioSha256: string;
    methodKey: string;
    methodConfigCanonicalSha256: string;
    methodConfigSourceSha256: string;
  }>(record.manifestPath);
  if (manifest.scenarioSha256 !== scenario.sha256
    || manifest.methodKey !== candidate.methodKey
    || manifest.methodConfigCanonicalSha256 !== candidate.methodConfigCanonicalSha256
    || manifest.methodConfigSourceSha256 !== candidate.methodConfigSourceSha256) {
    throw new Error(`Resume provenance mismatch for ${record.candidateId}/${record.scenarioId}`);
  }
}

function verifyPhaseResume(manifest: PhaseManifest, phase: RunPhase, expectedRunCount: number): void {
  if (manifest.phaseManifestVersion !== 1 || manifest.phase !== phase) {
    throw new Error(`Stale or malformed ${phase} manifest`);
  }
  if (manifest.repositoryCommit !== currentGitHead()) {
    throw new Error(`${phase} manifest was produced by another repository commit`);
  }
  if (manifest.expectedRunCount !== expectedRunCount) {
    throw new Error(`${phase} expected run count changed`);
  }
}

function validationPhaseForRunPhase(phase: RunPhase): ValidationPhase {
  if (phase === "screening") return "screening";
  if (phase === "validation-tuning") return "validationTuning";
  return "validationHoldout";
}

function runKey(candidateId: string, scenarioId: string): string {
  return `${candidateId}\0${scenarioId}`;
}

function containsNonFinite(value: unknown): boolean {
  if (typeof value === "number") return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some(containsNonFinite);
  if (value !== null && typeof value === "object") return Object.values(value).some(containsNonFinite);
  return false;
}
