import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runExperiment } from "../../experiments/cli/runExperiment";
import { generateFreeSpaceScenario } from "../../experiments/generation/freeSpace";
import { generatePairwiseScenario } from "../../experiments/generation/pairwise";
import { sha256Bytes } from "../../experiments/protocol/hash";
import { serializeExperimentScenario } from "../../experiments/protocol/schema";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("common headless experiment runner", () => {
  it("records exact hashes and computes metrics from every subsampled step", () => {
    const directory = temporaryDirectory();
    const scenario = generateFreeSpaceScenario("test", 3);
    scenario.simulation.dt = 0.05;
    scenario.simulation.horizonSeconds = 0.2;
    const scenarioBytes = serializeExperimentScenario(scenario);
    const scenarioPath = join(directory, "scenario.json");
    writeFileSync(scenarioPath, scenarioBytes, "utf8");
    const methodPath = resolve("experiments/methods/goal-projection.json");
    const methodBytes = readFileSync(methodPath, "utf8");
    const result = runExperiment({
      scenarioPath,
      methodPath,
      outputDirectory: join(directory, "run"),
      recordingInterval: 3,
      commandArguments: ["--fixture"],
    });

    expect(result.manifest.scenarioSha256).toBe(sha256Bytes(scenarioBytes));
    expect(result.manifest.methodConfigSha256).toBe(sha256Bytes(methodBytes));
    expect(result.manifest.commandArguments).toEqual(["--fixture"]);
    expect(result.summary.totalSteps).toBe(4);
    expect(result.metrics.smoothness.accelerationSampleCount).toBe(4);
    const trajectoryBytes = readFileSync(result.trajectoryPath, "utf8");
    expect(trajectoryBytes.endsWith("\n")).toBe(true);
    const records = trajectoryBytes.trim().split("\n").map((line) => JSON.parse(line) as { stepIndex: number });
    expect(records.map(({ stepIndex }) => stepIndex)).toEqual([2, 3]);
    expect(listFiles(directory).some((path) => path.endsWith(".tmp"))).toBe(false);
  });

  it("uses byte-identical physical scenario input for both methods", () => {
    const directory = temporaryDirectory();
    const scenario = generatePairwiseScenario("head_on", "validation", 0);
    scenario.simulation.horizonSeconds = scenario.simulation.dt * 2;
    const scenarioPath = join(directory, "scenario.json");
    writeFileSync(scenarioPath, serializeExperimentScenario(scenario), "utf8");
    const riemannian = runExperiment({
      scenarioPath,
      methodPath: "experiments/methods/riemannian-default.json",
      outputDirectory: join(directory, "riemannian"),
    });
    const goal = runExperiment({
      scenarioPath,
      methodPath: "experiments/methods/goal-projection.json",
      outputDirectory: join(directory, "goal"),
    });
    expect(riemannian.manifest.scenarioSha256).toBe(goal.manifest.scenarioSha256);
    expect(riemannian.manifest.controllerId).not.toBe(goal.manifest.controllerId);
  });

  it("writes a valid empty trajectory for a zero-step scenario", () => {
    const directory = temporaryDirectory();
    const scenario = generateFreeSpaceScenario("test", 0);
    scenario.simulation.horizonSeconds = 0;
    const scenarioPath = join(directory, "zero.json");
    writeFileSync(scenarioPath, serializeExperimentScenario(scenario), "utf8");
    const result = runExperiment({
      scenarioPath,
      methodPath: "experiments/methods/goal-projection.json",
      outputDirectory: join(directory, "run"),
    });
    expect(readFileSync(result.trajectoryPath, "utf8")).toBe("");
    expect(result.summary.totalSteps).toBe(0);
    expect(result.metrics.throughput).toBeNull();
    expect(listFiles(directory).some((path) => path.endsWith(".tmp"))).toBe(false);
  });

  it("removes finalized and temporary artifacts after invalid configuration failure", () => {
    const directory = temporaryDirectory();
    const scenarioPath = join(directory, "scenario.json");
    const methodPath = join(directory, "invalid-method.json");
    const outputDirectory = join(directory, "failed-run");
    writeFileSync(
      scenarioPath,
      serializeExperimentScenario(generateFreeSpaceScenario("test", 0)),
      "utf8",
    );
    writeFileSync(methodPath, '{"methodConfigVersion":1,"id":"invalid"}\n', "utf8");
    expect(() => runExperiment({ scenarioPath, methodPath, outputDirectory })).toThrow();
    expect(listFiles(outputDirectory)).toEqual([]);
    for (const filename of ["manifest.json", "trajectory.jsonl", "summary.json", "run-metrics.json"]) {
      expect(existsSync(join(outputDirectory, filename))).toBe(false);
    }
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "riemannian-stage-b-"));
  temporaryDirectories.push(directory);
  return directory;
}

function listFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}
