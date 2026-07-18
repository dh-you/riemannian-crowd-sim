import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runScenario, type RunScenarioResult } from "./runScenario";

interface SmokeCase {
  name: string;
  scenarioPath: string;
}

const cases: SmokeCase[] = [
  { name: "free-space", scenarioPath: "experiments/scenarios/free-space.json" },
  { name: "pairwise-offset", scenarioPath: "experiments/scenarios/pairwise-offset.json" },
];

function main(): void {
  try {
    const results = cases.map(runSmokeCase);
    const details = results.map((result) => `${result.summary.scenarioName}: ${result.summary.totalSteps} steps`);
    console.log(`core:smoke PASS (${details.join("; ")})`);
  } catch (error) {
    console.error(`core:smoke FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

function runSmokeCase(testCase: SmokeCase): RunScenarioResult {
  const result = runScenario({
    scenarioPath: resolve(testCase.scenarioPath),
    outputDirectory: resolve("results", "smoke", testCase.name),
    commandArguments: process.argv.slice(2),
  });
  const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8")) as unknown;
  const summary = JSON.parse(readFileSync(result.summaryPath, "utf8")) as unknown;
  const lines = readFileSync(result.trajectoryPath, "utf8").trim().split(/\r?\n/u).filter(Boolean);
  if (lines.length === 0) throw new Error(`${testCase.name} trajectory is empty`);
  const trajectory = lines.map((line) => JSON.parse(line) as unknown);
  for (const [name, value] of Object.entries({ manifest, summary, trajectory })) {
    if (containsNonFinite(value)) throw new Error(`${testCase.name} ${name} contains a non-finite value`);
  }
  if (result.summary.nonFiniteValueOccurred) {
    throw new Error(`${testCase.name} reported a non-finite value`);
  }
  return result;
}

function containsNonFinite(value: unknown): boolean {
  if (typeof value === "number") return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some(containsNonFinite);
  if (value !== null && typeof value === "object") return Object.values(value).some(containsNonFinite);
  return false;
}

main();
