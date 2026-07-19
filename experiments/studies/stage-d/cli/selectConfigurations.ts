import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sha256File } from "../../../protocol/hash";
import type { PhaseManifest } from "../phaseRunner";
import {
  RESULTS_ROOT,
  currentGitHead,
  phaseManifestPath,
  planFileHashes,
  readJson,
  verifyPreregisteredPlan,
  writeJson,
} from "../studyPaths";

export interface SelectionManifest {
  selectionManifestVersion: 1;
  status: "PASS";
  repositoryCommit: string;
  planHashes: Record<string, string>;
  phaseManifestHashes: Record<string, string>;
  selected: Record<string, { candidateId: string; methodKey: string }>;
  eliminationTraces: Record<string, unknown>;
}

export function selectConfigurations(): SelectionManifest {
  verifyPreregisteredPlan();
  const phases = ["screening", "validation-tuning", "validation-holdout"] as const;
  const manifests = Object.fromEntries(phases.map((phase) => {
    const manifest = readJson<PhaseManifest>(phaseManifestPath(phase));
    if (manifest.status !== "PASS") throw new Error(`${phase} is not complete and passing`);
    return [phase, manifest];
  })) as Record<(typeof phases)[number], PhaseManifest>;
  const selected: SelectionManifest["selected"] = {};
  for (const methodId of [
    "conditioned_riemannian_metric_v1",
    "orca_rvo2_v1",
    "social_force_pysocialforce_v1",
  ]) {
    const result = manifests["validation-holdout"].selection[methodId];
    if (result === undefined || result.ranked.length === 0) {
      throw new Error(`Holdout selection is missing ${methodId}`);
    }
    const winner = result.ranked[0];
    selected[methodId] = { candidateId: winner.candidateId, methodKey: winner.methodKey };
  }
  const manifest: SelectionManifest = {
    selectionManifestVersion: 1,
    status: "PASS",
    repositoryCommit: currentGitHead(),
    planHashes: planFileHashes(),
    phaseManifestHashes: Object.fromEntries(phases.map((phase) => [
      phase,
      sha256File(phaseManifestPath(phase)),
    ])),
    selected,
    eliminationTraces: Object.fromEntries(phases.map((phase) => [phase, manifests[phase].selection])),
  };
  const manifestPath = phaseManifestPath("selection");
  writeJson(manifestPath, manifest);
  const compactRoot = resolve(RESULTS_ROOT, "compact");
  writeJson(resolve(compactRoot, "validation-selection.json"), manifest);
  const rows = [
    "phase,method_id,candidate_id,method_key,rank,first_front_exclusion,macro_success,macro_overlap_exposure,macro_maximum_penetration,macro_normalized_travel_time,macro_rms_acceleration,run_count",
  ];
  for (const phase of phases) {
    for (const [methodId, result] of Object.entries(manifests[phase].selection)) {
      for (const entry of result.trace) {
        const score = entry.score;
        rows.push([
          phase,
          methodId,
          entry.candidateId,
          entry.methodKey,
          entry.rank,
          entry.firstFrontExclusion ?? "",
          score.macroSuccess,
          score.macroOverlapExposure,
          score.macroMaximumPenetration,
          score.macroNormalizedTravelTime ?? "",
          score.macroRmsAcceleration ?? "",
          score.runCount,
        ].join(","));
      }
    }
  }
  const csvPath = resolve(compactRoot, "validation-selection.csv");
  mkdirSync(dirname(csvPath), { recursive: true });
  writeFileSync(csvPath, `${rows.join("\n")}\n`, "utf8");
  return manifest;
}

function main(): void {
  try {
    const manifest = selectConfigurations();
    console.log(`study:d:select PASS: ${JSON.stringify(manifest.selected)}`);
  } catch (error) {
    console.error(`study:d:select failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) main();
