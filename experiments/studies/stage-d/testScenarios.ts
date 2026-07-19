import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { generateExperimentScenario } from "../../generation/generateScenario";
import { sha256Bytes } from "../../protocol/hash";
import { serializeExperimentScenario } from "../../protocol/schema";
import { RESULTS_ROOT, SCENARIO_PARTITIONS_PATH, readJson } from "./studyPaths";
import type { StudyScenarioEntry } from "./scenarios";

interface TestEntry {
  family: string;
  variants: string[];
  seedStart: number;
  seedEnd: number;
  agentCount: number;
}

interface TestPartitions {
  scenarioPartitionsVersion: 1;
  frozenTest: {
    split: "test";
    entries: TestEntry[];
    expectedScenarioCount: number;
    expectedMethodCount: number;
    expectedRunCount: number;
  };
}

export function materializeFrozenTestScenarios(): StudyScenarioEntry[] {
  const partitions = readJson<TestPartitions>(SCENARIO_PARTITIONS_PATH);
  if (partitions.scenarioPartitionsVersion !== 1) throw new Error("Unsupported scenario partitions");
  const partition = partitions.frozenTest;
  const root = resolve(RESULTS_ROOT, "scenarios/test");
  const scenarios: StudyScenarioEntry[] = [];
  for (const entry of partition.entries) {
    for (const variant of entry.variants) {
      for (let seed = entry.seedStart; seed <= entry.seedEnd; seed += 1) {
        const scenario = generateExperimentScenario({
          family: entry.family,
          variant,
          split: "test",
          seed,
          agentCount: entry.agentCount,
        });
        const source = serializeExperimentScenario(scenario);
        const path = resolve(root, entry.family, variant, `seed-${seed}.json`);
        mkdirSync(dirname(path), { recursive: true });
        if (existsSync(path) && readFileSync(path, "utf8") !== source) {
          throw new Error(`Frozen test scenario differs from audited generation: ${path}`);
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
  if (scenarios.length !== partition.expectedScenarioCount
    || scenarios.length * partition.expectedMethodCount !== partition.expectedRunCount) {
    throw new Error("Frozen test Cartesian count differs from preregistration");
  }
  return scenarios;
}
