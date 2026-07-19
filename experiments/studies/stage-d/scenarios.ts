import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { generateExperimentScenario } from "../../generation/generateScenario";
import { sha256Bytes } from "../../protocol/hash";
import { serializeExperimentScenario } from "../../protocol/schema";
import {
  RESULTS_ROOT,
  SCENARIO_PARTITIONS_PATH,
  planFileHashes,
  readJson,
  verifyPreregisteredPlan,
  writeJson,
} from "./studyPaths";

export type ValidationPhase = "screening" | "validationTuning" | "validationHoldout";

interface PartitionEntry {
  family: string;
  variants: string[];
  seeds: number[];
  agentCount: number;
}

interface Partition {
  split: string;
  entries: PartitionEntry[];
  expectedScenarioCount: number;
}

interface ScenarioPartitions {
  scenarioPartitionsVersion: 1;
  screening: Partition;
  validationTuning: Partition;
  validationHoldout: Partition;
}

export interface StudyScenarioEntry {
  scenarioId: string;
  path: string;
  sha256: string;
  family: string;
  variant: string;
  split: string;
  seed: number;
  agentCount: number;
}

export interface StudyScenarioManifest {
  scenarioManifestVersion: 1;
  phase: ValidationPhase;
  planHashes: Record<string, string>;
  scenarios: StudyScenarioEntry[];
}

export function materializeValidationScenarios(phase: ValidationPhase): StudyScenarioManifest {
  verifyPreregisteredPlan();
  const partitions = readJson<ScenarioPartitions>(SCENARIO_PARTITIONS_PATH);
  if (partitions.scenarioPartitionsVersion !== 1) throw new Error("Unsupported scenario partitions");
  const partition = partitions[phase];
  const root = resolve(RESULTS_ROOT, "scenarios", phase);
  const scenarios: StudyScenarioEntry[] = [];
  for (const entry of partition.entries) {
    for (const variant of entry.variants) {
      for (const seed of entry.seeds) {
        const scenario = generateExperimentScenario({
          family: entry.family,
          variant,
          split: partition.split,
          seed,
          agentCount: entry.agentCount,
        });
        const source = serializeExperimentScenario(scenario);
        const path = resolve(root, entry.family, variant, `seed-${seed}.json`);
        mkdirSync(dirname(path), { recursive: true });
        if (existsSync(path) && readFileSync(path, "utf8") !== source) {
          throw new Error(`Existing ${phase} scenario differs from audited generation: ${path}`);
        }
        writeFileSync(path, source, "utf8");
        scenarios.push({
          scenarioId: `${entry.family}/${variant}/seed-${seed}`,
          path,
          sha256: sha256Bytes(source),
          family: scenario.family,
          variant: scenario.variant,
          split: scenario.split,
          seed: scenario.seed,
          agentCount: scenario.agents.length,
        });
      }
    }
  }
  scenarios.sort((first, second) => first.scenarioId.localeCompare(second.scenarioId));
  if (scenarios.length !== partition.expectedScenarioCount) {
    throw new Error(
      `${phase} scenario count mismatch: expected ${partition.expectedScenarioCount}, received ${scenarios.length}`,
    );
  }
  const manifest: StudyScenarioManifest = {
    scenarioManifestVersion: 1,
    phase,
    planHashes: planFileHashes(),
    scenarios,
  };
  writeJson(resolve(root, "scenario-manifest.json"), manifest);
  return manifest;
}
