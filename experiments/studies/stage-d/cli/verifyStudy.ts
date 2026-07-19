import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { RunMetrics } from "../../../metrics/types";
import { sha256File } from "../../../protocol/hash";
import { FREEZE_MANIFEST_PATH, type FreezeManifest } from "./freezeConfigurations";
import type { FrozenTestShardManifest } from "./runFrozenTest";
import {
  PAPER_ROOT,
  RESULTS_ROOT,
  currentGitHead,
  git,
  phaseManifestPath,
  readJson,
  verifyPreregisteredPlan,
  writeJson,
} from "../studyPaths";

export function verifyStudy(): { verifiedRunCount: number; paperAssetCount: number } {
  const plan = verifyPreregisteredPlan();
  const freeze = readJson<FreezeManifest>(FREEZE_MANIFEST_PATH);
  if (freeze.freezeManifestVersion !== 1 || freeze.status !== "FROZEN") {
    throw new Error("Freeze manifest is malformed");
  }
  const headSubject = git(["show", "-s", "--format=%s", "HEAD"]);
  if (headSubject !== "Freeze Stage D method configurations") {
    throw new Error("Study verification must run before the results commit, at the freeze commit");
  }
  if (git(["rev-parse", "HEAD^"]) !== freeze.repositoryShaBeforeFreeze) {
    throw new Error("Freeze commit ancestry mismatch");
  }
  const protectedPaths = [
    "src/core",
    "experiments/engines",
    "experiments/metrics/RunMetricsAccumulator.ts",
    "experiments/protocol/schema.ts",
    "experiments/generation",
    "experiments/baselines",
    "experiments/suites/protocol-v1.json",
  ];
  const protectedChanges = git([
    "diff",
    "--name-only",
    plan.d0BaseCommit,
    "--",
    ...protectedPaths,
  ]).split(/\r?\n/u).filter(Boolean);
  if (protectedChanges.length > 0) {
    throw new Error(`Frozen scientific implementation changed: ${protectedChanges.join(", ")}`);
  }
  for (const method of freeze.frozenMethods) {
    if (sha256File(method.path) !== method.methodConfigSourceSha256) {
      throw new Error(`Frozen config changed: ${method.methodId}`);
    }
  }
  for (const scenario of freeze.testScenarios) {
    if (sha256File(scenario.path) !== scenario.sha256) {
      throw new Error(`Frozen scenario changed: ${scenario.scenarioId}`);
    }
  }
  const merged = readJson<{
    status: string;
    completedRunCount: number;
    scenarioCount: number;
    methodCount: number;
    runs: FrozenTestShardManifest["completed"];
  }>(resolve(RESULTS_ROOT, "test/merged-test-manifest.json"));
  if (merged.status !== "PASS" || merged.completedRunCount !== 1160
    || merged.scenarioCount !== 290 || merged.methodCount !== 4) {
    throw new Error("Frozen test Cartesian product is incomplete");
  }
  const pairSet = new Set<string>();
  const scenarioMethodHashes = new Map<string, Set<string>>();
  const frozenKeys = new Set(freeze.frozenMethods.map(({ methodKey }) => methodKey));
  for (const run of merged.runs) {
    const pair = `${run.scenarioId}\0${run.methodKey}`;
    if (pairSet.has(pair)) throw new Error(`Duplicate frozen test pair: ${pair}`);
    pairSet.add(pair);
    if (!frozenKeys.has(run.methodKey)) throw new Error(`Non-frozen method result: ${run.methodKey}`);
    const methodHashes = scenarioMethodHashes.get(run.scenarioId) ?? new Set<string>();
    methodHashes.add(run.scenarioSha256);
    scenarioMethodHashes.set(run.scenarioId, methodHashes);
    const metrics = readJson<RunMetrics>(run.metricsPath);
    if (metrics.identity.methodKey !== run.methodKey || containsNonFinite(metrics)) {
      throw new Error(`Invalid frozen metrics: ${run.metricsPath}`);
    }
  }
  if ([...scenarioMethodHashes.values()].some((hashes) => hashes.size !== 1)) {
    throw new Error("Scenario hashes differ across frozen methods");
  }
  for (const phase of ["ablations", "runtime", "analysis", "paper"]) {
    const manifest = readJson<{ status?: string }>(phaseManifestPath(phase));
    if (manifest.status !== "PASS") throw new Error(`${phase} manifest is not passing`);
  }
  const paper = readJson<{
    status: string;
    files: Array<{ path: string; sha256: string }>;
  }>(phaseManifestPath("paper"));
  for (const file of paper.files) {
    if (!existsSync(file.path) || sha256File(file.path) !== file.sha256) {
      throw new Error(`Paper asset hash mismatch: ${file.path}`);
    }
    const source = readFileSync(file.path, "utf8");
    if (/\b(?:NaN|[-+]?Infinity)\b/u.test(source)) {
      throw new Error(`Paper asset contains a non-finite string: ${file.path}`);
    }
  }
  verifyFigureSource(resolve(PAPER_ROOT, "figures/main-comparison.svg"), [
    sha256File(resolve(PAPER_ROOT, "data/main-results.csv")),
  ]);
  verifyFigureSource(resolve(PAPER_ROOT, "figures/ablation-sensitivity.svg"), [
    sha256File(resolve(PAPER_ROOT, "data/ablation-results.csv")),
    sha256File(resolve(PAPER_ROOT, "data/sensitivity-results.csv")),
  ]);
  verifyFigureSource(resolve(PAPER_ROOT, "figures/runtime-scaling.svg"), [
    sha256File(resolve(PAPER_ROOT, "data/runtime-results.csv")),
  ]);
  verifyFigureSource(resolve(PAPER_ROOT, "figures/pairwise-trajectories.svg"), [
    sha256File(resolve(PAPER_ROOT, "data/pairwise-trajectories.csv")),
  ]);
  const temporaryFiles = listFiles(resolve("experiments/tmp"));
  if (temporaryFiles.length > 0) {
    throw new Error(`Stale temporary files remain: ${temporaryFiles.slice(0, 5).join(", ")}`);
  }
  const verification = {
    studyVerificationVersion: 1,
    status: "PASS",
    repositoryCommit: currentGitHead(),
    freezeManifestSha256: sha256File(FREEZE_MANIFEST_PATH),
    verifiedRunCount: merged.completedRunCount,
    scenarioCount: merged.scenarioCount,
    methodCount: merged.methodCount,
    paperAssetCount: paper.files.length,
    protectedScientificFileChanges: protectedChanges,
    nonFiniteValues: false,
    duplicateRuns: false,
    missingRuns: false,
    nonFrozenResults: false,
  };
  writeJson(phaseManifestPath("verification"), verification);
  return { verifiedRunCount: merged.completedRunCount, paperAssetCount: paper.files.length };
}

function verifyFigureSource(path: string, hashes: readonly string[]): void {
  const source = readFileSync(path, "utf8");
  for (const hash of hashes) {
    if (!source.includes(hash)) throw new Error(`Figure does not identify source data hash: ${path}`);
  }
}

function listFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    listFiles(resolve(path, entry.name)));
}

function containsNonFinite(value: unknown): boolean {
  if (typeof value === "number") return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some(containsNonFinite);
  if (value !== null && typeof value === "object") return Object.values(value).some(containsNonFinite);
  return false;
}

function main(): void {
  try {
    const result = verifyStudy();
    console.log(`study:d:verify PASS: ${result.verifiedRunCount} frozen runs, ${result.paperAssetCount} paper assets`);
  } catch (error) {
    console.error(`study:d:verify failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) main();
