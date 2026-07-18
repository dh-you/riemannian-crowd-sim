import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { generateBidirectionalScenario } from "../generation/bidirectional";
import { generateBottleneckScenario } from "../generation/bottleneck";
import { generateCircleAntipodalScenario } from "../generation/circleAntipodal";
import { generateFreeSpaceScenario } from "../generation/freeSpace";
import { generatePairwiseScenario } from "../generation/pairwise";
import { identifyMethod } from "../protocol/methodIdentity";
import { parseMethodConfig } from "../protocol/methodConfig";
import { serializeExperimentScenario, type ExperimentScenario } from "../protocol/schema";
import { runExperiment } from "./runExperiment";

const METHODS = [
  "experiments/methods/riemannian-default.json",
  "experiments/methods/goal-projection.json",
  "experiments/methods/orca-default.json",
  "experiments/methods/social-force-default.json",
] as const;

export interface BaselineSmokeResult {
  scenarios: number;
  runs: number;
  outputDirectory: string;
}

export function runBaselineSmoke(outputDirectory = "results/baseline-smoke"): BaselineSmokeResult {
  const root = resolve(outputDirectory);
  assertSafeDirectory(root);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const scenarios = smokeScenarios();
  let runs = 0;
  for (const source of scenarios) {
    const scenario = { ...source, simulation: { ...source.simulation, horizonSeconds: 0.25 } };
    const scenarioPath = resolve(root, "scenarios", `${scenario.name}.json`);
    mkdirSync(resolve(root, "scenarios"), { recursive: true });
    writeFileSync(scenarioPath, serializeExperimentScenario(scenario), "utf8");
    const scenarioHashes = new Set<string>();
    for (const methodPath of METHODS) {
      const bytes = readFileSync(resolve(methodPath), "utf8");
      const method = parseMethodConfig(JSON.parse(bytes) as unknown);
      const identity = identifyMethod(method, bytes);
      const result = runExperiment({
        scenarioPath,
        methodPath,
        outputDirectory: resolve(root, "runs", scenario.name, identity.methodKey),
        recordingInterval: 5,
        commandArguments: ["baselineSmoke"],
      });
      scenarioHashes.add(result.manifest.scenarioSha256);
      if (result.manifest.engineId.length === 0 || containsNonFinite(result.metrics)) {
        throw new Error(`Invalid baseline smoke output for ${scenario.name}/${method.id}`);
      }
      if (
        (method.id === "orca_rvo2_v1" || method.id === "social_force_pysocialforce_v1") &&
        (result.manifest.upstreamCommit === null ||
          result.manifest.runnerSha256 === null ||
          result.metrics.correctionDependence.totalCorrectionDisplacement !== 0)
      ) {
        throw new Error(`Missing native baseline provenance or correction semantics for ${method.id}`);
      }
      console.log(`PASS ${scenario.name} ${method.id}`);
      runs += 1;
    }
    if (scenarioHashes.size !== 1) throw new Error(`Scenario hash differs across methods: ${scenario.name}`);
  }
  const temporaryArtifacts = listFiles(resolve("experiments", "tmp"));
  if (temporaryArtifacts.length > 0) {
    throw new Error(`Baseline smoke left temporary artifacts: ${temporaryArtifacts.join(", ")}`);
  }
  return { scenarios: scenarios.length, runs, outputDirectory: root };
}

function smokeScenarios(): ExperimentScenario[] {
  return [
    generateFreeSpaceScenario("smoke", 0),
    generatePairwiseScenario("head_on", "smoke", 0),
    generatePairwiseScenario("crossing", "smoke", 0),
    generatePairwiseScenario("separating", "smoke", 0),
    generateCircleAntipodalScenario("smoke", 0, 8),
    generateBidirectionalScenario("smoke", 0, 12),
    generateBottleneckScenario("smoke", 0, 16),
  ];
}

function assertSafeDirectory(path: string): void {
  const workspace = resolve(".");
  const relativePath = relative(workspace, path);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`Refusing to clear baseline smoke directory outside workspace: ${path}`);
  }
}

function containsNonFinite(value: unknown): boolean {
  if (typeof value === "number") return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some(containsNonFinite);
  if (value !== null && typeof value === "object") return Object.values(value).some(containsNonFinite);
  return false;
}

function listFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

function main(): void {
  try {
    const result = runBaselineSmoke();
    console.log(`baselines:smoke passed: ${result.scenarios} scenarios, ${result.runs} method runs`);
  } catch (error) {
    console.error(`baselines:smoke failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) main();
