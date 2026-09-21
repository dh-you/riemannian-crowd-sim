import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runExperiment, type RunExperimentResult } from "../../experiments/cli/runExperiment";
import {
  parseExperimentScenario,
  serializeExperimentScenario,
  type ExperimentScenario,
} from "../../experiments/protocol/schema";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("real pinned ORCA/RVO2 integration", () => {
  it("moves one free agent at preferred speed without Scientific Core smoothing or correction", () => {
    const result = runFixture(shortened(loadFixture("free-space"), 3), "orca-default.json");
    const first = trajectory(result)[0];
    const agent = first.agents[0];
    expect(agent.commandVelocity).toBeDefined();
    expect(Math.hypot(...agent.commandVelocity)).toBeCloseTo(1.4, 6);
    expect(agent.commandVelocity[1]).toBeCloseTo(0, 7);
    expect(agent.realizedVelocity[0]).toBeCloseTo(agent.commandVelocity[0], 5);
    expect(agent.realizedVelocity[1]).toBeCloseTo(agent.commandVelocity[1], 5);
    expect(result.manifest.correctionMode).toBe("native_none");
    expect(result.metrics.correctionDependence.totalCorrectionDisplacement).toBe(0);
  });

  it.each(["pairwise-offset-head-on", "pairwise-crossing"] as const)("keeps stable IDs and finite native records for %s agents", (fixtureName) => {
    const result = runFixture(shortened(loadFixture(fixtureName), 10), "orca-default.json");
    for (const record of trajectory(result)) {
      expect(record.agents.map((agent) => agent.id)).toEqual([0, 1]);
      expect(JSON.stringify(record)).not.toMatch(/NaN|Infinity/u);
      expect(record.diagnostics.agentCorrectionDisplacement).toBe(0);
      expect(record.diagnostics.wallCorrectionDisplacement).toBe(0);
    }
  });

  it("accepts deterministic expanded wall geometry", () => {
    const result = runFixture(shortened(loadFixture("wall-approach"), 5), "orca-default.json");
    expect(result.summary.totalSteps).toBe(5);
    expect(result.manifest.upstreamCommit).toMatch(/^[a-f0-9]{40}$/u);
  });

  it("produces byte-identical step records on repeated runs", () => {
    const scenario = shortened(loadFixture("pairwise-offset-head-on"), 10);
    const first = runFixture(scenario, "orca-default.json");
    const second = runFixture(scenario, "orca-default.json");
    expect(readFileSync(first.trajectoryPath, "utf8")).toBe(readFileSync(second.trajectoryPath, "utf8"));
  });
});

interface TrajectoryAgentRecord {
  id: number;
  commandVelocity: [number, number];
  realizedVelocity: [number, number];
}

interface TrajectoryStep {
  agents: TrajectoryAgentRecord[];
  diagnostics: { agentCorrectionDisplacement: number; wallCorrectionDisplacement: number };
}

function runFixture(scenario: ExperimentScenario, methodName: string): RunExperimentResult {
  const directory = mkdtempSync(resolve(tmpdir(), "stage-c-baseline-test-"));
  temporaryDirectories.push(directory);
  const scenarioPath = resolve(directory, "scenario.json");
  writeFileSync(scenarioPath, serializeExperimentScenario(scenario), "utf8");
  return runExperiment({
    scenarioPath,
    methodPath: resolve("experiments", "methods", methodName),
    outputDirectory: resolve(directory, "run"),
  });
}

function loadFixture(name: string): ExperimentScenario {
  const source = readFileSync(resolve("experiments", "baselines", "fixtures", `${name}.json`), "utf8");
  return parseExperimentScenario(JSON.parse(source) as unknown);
}

function trajectory(result: RunExperimentResult): TrajectoryStep[] {
  return readFileSync(result.trajectoryPath, "utf8").trim().split(/\r?\n/u).filter(Boolean)
    .map((line) => JSON.parse(line) as TrajectoryStep);
}

function shortened(scenario: ExperimentScenario, steps: number): ExperimentScenario {
  return {
    ...scenario,
    simulation: { ...scenario.simulation, horizonSeconds: scenario.simulation.dt * steps },
    agents: scenario.agents.map((agent) => ({ ...agent, position: [...agent.position], velocity: [...agent.velocity], goal: [...agent.goal] })),
    walls: scenario.walls.map((wall) => ({ ...wall, start: [...wall.start], end: [...wall.end] })),
  };
}
