import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { sha256File } from "../../protocol/hash";

export const STUDY_ROOT = resolve("experiments/studies/stage-d");
export const PLAN_ROOT = resolve(STUDY_ROOT, "plan");
export const RESULTS_ROOT = resolve("results/stage-d");
export const PAPER_ROOT = resolve("paper-assets/stage-d");

export const STUDY_PLAN_PATH = resolve(PLAN_ROOT, "study-plan.json");
export const METRIC_POLICY_PATH = resolve(PLAN_ROOT, "metric-policy.json");
export const CANDIDATE_SPACE_PATH = resolve(PLAN_ROOT, "candidate-space.json");
export const SCENARIO_PARTITIONS_PATH = resolve(PLAN_ROOT, "scenario-partitions.json");
export const CANDIDATE_MANIFEST_PATH = resolve(RESULTS_ROOT, "candidates/manifest.json");

export interface StudyPlan {
  studyPlanVersion: 1;
  studyId: string;
  d0BaseCommit: string;
  ablationPreparationCommit: string;
  repositoryShaAtCreation: string;
  provenance: {
    d0ReportPath: string;
    d0ReportSha256: string;
    humanReviewPath: string;
    humanReviewSha256: string;
    scenarioSuitePath: string;
    scenarioSuiteSha256: string;
    thirdPartyLockPath: string;
    thirdPartyLockSha256: string;
    baselineBuildManifestPath: string;
    baselineBuildManifestSha256: string;
  };
  lockedPlanInputs: {
    metricPolicyPath: string;
    metricPolicySha256: string;
    candidateSpacePath: string;
    candidateSpaceSha256: string;
    scenarioPartitionsPath: string;
    scenarioPartitionsSha256: string;
  };
  statisticsPolicy: {
    bootstrapSeed: number;
    bootstrapReplicates: number;
    confidenceLevel: number;
  };
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

export function git(arguments_: readonly string[]): string {
  return execFileSync("git", arguments_, {
    cwd: resolve("."),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function currentGitHead(): string {
  return git(["rev-parse", "HEAD"]);
}

export function verifyPreregisteredPlan(): StudyPlan {
  const plan = readJson<StudyPlan>(STUDY_PLAN_PATH);
  if (plan.studyPlanVersion !== 1 || plan.studyId !== "eumas-stage-d-2026") {
    throw new Error("Unsupported Stage D study plan");
  }
  const checks: Array<[string, string]> = [
    [plan.provenance.d0ReportPath, plan.provenance.d0ReportSha256],
    [plan.provenance.humanReviewPath, plan.provenance.humanReviewSha256],
    [plan.provenance.scenarioSuitePath, plan.provenance.scenarioSuiteSha256],
    [plan.provenance.thirdPartyLockPath, plan.provenance.thirdPartyLockSha256],
    [plan.provenance.baselineBuildManifestPath, plan.provenance.baselineBuildManifestSha256],
    [plan.lockedPlanInputs.metricPolicyPath, plan.lockedPlanInputs.metricPolicySha256],
    [plan.lockedPlanInputs.candidateSpacePath, plan.lockedPlanInputs.candidateSpaceSha256],
    [plan.lockedPlanInputs.scenarioPartitionsPath, plan.lockedPlanInputs.scenarioPartitionsSha256],
  ];
  for (const [path, expected] of checks) {
    if (!existsSync(path)) throw new Error(`Preregistered input is missing: ${path}`);
    const actual = sha256File(path);
    if (actual !== expected) throw new Error(`Preregistered hash mismatch for ${path}`);
  }
  const d0Report = readJson<{ readinessDecision?: string; environment?: { repositoryCommit?: string } }>(
    plan.provenance.d0ReportPath,
  );
  if (d0Report.readinessDecision !== "READY AFTER HUMAN VISUAL REVIEW") {
    throw new Error("D0 readiness is no longer READY AFTER HUMAN VISUAL REVIEW");
  }
  if (d0Report.environment?.repositoryCommit !== plan.ablationPreparationCommit) {
    throw new Error("D0 report does not audit the ablation preparation commit");
  }
  const review = readJson<{ reviewedBy?: string; approved?: boolean }>(plan.provenance.humanReviewPath);
  if (review.reviewedBy !== "Derek You" || review.approved !== true) {
    throw new Error("Required human visual approval is absent or malformed");
  }
  return plan;
}

export function phaseManifestPath(phase: string): string {
  return resolve(RESULTS_ROOT, "manifests", `${phase}-manifest.json`);
}

export function planFileHashes(): Record<string, string> {
  return {
    studyPlanSha256: sha256File(STUDY_PLAN_PATH),
    metricPolicySha256: sha256File(METRIC_POLICY_PATH),
    candidateSpaceSha256: sha256File(CANDIDATE_SPACE_PATH),
    scenarioPartitionsSha256: sha256File(SCENARIO_PARTITIONS_PATH),
  };
}
