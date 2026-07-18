import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { generateBidirectionalScenario } from "../generation/bidirectional";
import { generateBottleneckScenario } from "../generation/bottleneck";
import { generateCircleAntipodalScenario } from "../generation/circleAntipodal";
import { generateFreeSpaceScenario } from "../generation/freeSpace";
import { generatePairwiseScenario } from "../generation/pairwise";
import { serializeExperimentScenario, type ExperimentScenario } from "../protocol/schema";
import { runExperiment } from "./runExperiment";

const METHOD_PATHS = [
  "experiments/methods/riemannian-default.json",
  "experiments/methods/goal-projection.json",
] as const;

export interface ExperimentSmokeResult {
  scenarios: number;
  runs: number;
  outputDirectory: string;
}

export function runExperimentSmoke(outputDirectory = "results/experiment-smoke"): ExperimentSmokeResult {
  const root = resolve(outputDirectory);
  assertSafeSmokeDirectory(root);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  const scenarios = smokeScenarios();
  const scenarioDirectory = resolve(root, "scenarios");
  mkdirSync(scenarioDirectory, { recursive: true });
  let runs = 0;
  for (const scenario of scenarios) {
    const shortened = {
      ...scenario,
      simulation: { ...scenario.simulation, horizonSeconds: 0.25 },
    };
    const scenarioPath = resolve(scenarioDirectory, `${shortened.name}.json`);
    writeFileSync(scenarioPath, serializeExperimentScenario(shortened), "utf8");
    for (const methodPath of METHOD_PATHS) {
      const methodId = JSON.parse(readFileSync(resolve(methodPath), "utf8")) as { id?: unknown };
      if (typeof methodId.id !== "string") throw new Error(`Method config has no string id: ${methodPath}`);
      const runDirectory = resolve(root, "runs", shortened.name, methodId.id);
      const result = runExperiment({
        scenarioPath,
        methodPath,
        outputDirectory: runDirectory,
        recordingInterval: 5,
        commandArguments: ["experimentSmoke"],
      });
      for (const path of [result.manifestPath, result.trajectoryPath, result.summaryPath, result.metricsPath]) {
        if (!existsSync(path)) throw new Error(`Missing smoke artifact: ${path}`);
      }
      JSON.parse(readFileSync(result.manifestPath, "utf8"));
      JSON.parse(readFileSync(result.summaryPath, "utf8"));
      JSON.parse(readFileSync(result.metricsPath, "utf8"));
      const trajectoryLines = readFileSync(result.trajectoryPath, "utf8").trim().split("\n");
      if (trajectoryLines.some((line) => containsNonFinite(JSON.parse(line) as unknown))) {
        throw new Error(`Non-finite trajectory output in ${runDirectory}`);
      }
      if (containsNonFinite(result.summary) || containsNonFinite(result.metrics)) {
        throw new Error(`Non-finite structured output in ${runDirectory}`);
      }
      runs += 1;
    }
  }

  const temporaryFiles = listFiles(root).filter((path) => path.endsWith(".tmp"));
  if (temporaryFiles.length > 0) {
    throw new Error(`Temporary artifacts remain: ${temporaryFiles.map((path) => relative(root, path)).join(", ")}`);
  }
  return { scenarios: scenarios.length, runs, outputDirectory: root };
}

function smokeScenarios(): ExperimentScenario[] {
  return [
    generateFreeSpaceScenario("smoke", 0),
    generatePairwiseScenario("head_on", "smoke", 0),
    generatePairwiseScenario("separating", "smoke", 1),
    generateCircleAntipodalScenario("smoke", 0, 8),
    generateBidirectionalScenario("smoke", 0, 12),
    generateBottleneckScenario("smoke", 0, 16),
  ];
}

function assertSafeSmokeDirectory(path: string): void {
  const workspace = resolve(".");
  const relativePath = relative(workspace, path);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Refusing to clear smoke directory outside the workspace: ${path}`);
  }
}

function listFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

function containsNonFinite(value: unknown): boolean {
  if (typeof value === "number") return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some(containsNonFinite);
  if (value !== null && typeof value === "object") return Object.values(value).some(containsNonFinite);
  return false;
}

function main(): void {
  try {
    const result = runExperimentSmoke();
    console.log(`exp:smoke passed: ${result.scenarios} scenarios, ${result.runs} method runs`);
    console.log(`outputs: ${relative(resolve("."), result.outputDirectory)}`);
  } catch (error) {
    console.error(`exp:smoke failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) main();
