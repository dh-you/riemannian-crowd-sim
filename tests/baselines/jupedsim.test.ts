import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createJuPedSimGeometry } from "../../experiments/baselines/jupedsim/geometry";
import { runExperiment, type RunExperimentResult } from "../../experiments/cli/runExperiment";
import { generateBidirectionalScenario } from "../../experiments/generation/bidirectional";
import { generateBottleneckScenario } from "../../experiments/generation/bottleneck";
import { generateCircleAntipodalScenario } from "../../experiments/generation/circleAntipodal";
import { generatePairwiseScenario } from "../../experiments/generation/pairwise";
import { createJuPedSimInput } from "../../experiments/engines/JuPedSimSfmEngine";
import { parseMethodConfig, type JuPedSimSfmMethodConfig } from "../../experiments/protocol/methodConfig";
import {
  parseExperimentScenario,
  serializeExperimentScenario,
  type ExperimentScenario,
} from "../../experiments/protocol/schema";
import type { TrajectoryRecord } from "../../experiments/output/types";

const temporaryDirectories: string[] = [];
const METHOD_PATH = resolve("experiments", "methods", "jupedsim-sfm-default.json");

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("real pinned JuPedSim 1.4.2 SocialForceModel integration", () => {
  it("maps scenario-specific free-space values and emits a finite native trajectory", () => {
    const scenario = shortened(loadFixture("free-space"), 12);
    const method = loadMethod();
    const input = createJuPedSimInput(scenario, method);
    expect(input.dt).toBe(scenario.simulation.dt);
    expect(input.steps).toBe(12);
    expect(input.agents[0].radius).toBe(scenario.agents[0].radius);
    expect(input.agents[0].preferredSpeed).toBe(scenario.agents[0].preferredSpeed);
    const result = runScenario(scenario);
    const steps = trajectory(result);
    expect(steps).toHaveLength(12);
    expect(steps.every((step) => step.agents.map((agent) => agent.id).join(",") === "0")).toBe(true);
    expect(steps.at(-1)!.agents[0].position[0])
      .toBeGreaterThan(scenario.agents[0].position[0]);
    expect(JSON.stringify(steps)).not.toMatch(/NaN|Infinity/u);
    expect(result.manifest.correctionMode).toBe("native_none");
    expect(result.metrics.correctionDependence.totalCorrectionDisplacement).toBe(0);
  });

  it("keeps head-on IDs stable, reports shared point goals, and repeats byte-identically", () => {
    const scenario = shortened(generatePairwiseScenario("head_on", "test", 400), 90);
    const first = runScenario(scenario);
    const second = runScenario(scenario);
    expect(readFileSync(first.trajectoryPath, "utf8"))
      .toBe(readFileSync(second.trajectoryPath, "utf8"));
    for (const step of trajectory(first)) {
      expect(step.agents.map((agent) => agent.id)).toEqual([0, 1]);
      for (const agent of step.agents) {
        expect(agent.navigationTarget).toEqual(scenario.agents[agent.id].goal);
      }
    }
    expect(first.manifest.correctionMode).toBe("native_none");
  });

  it("keeps every circle agent present with deterministic geometry and finite states", () => {
    const scenario = shortened(generateCircleAntipodalScenario("test", 400, 12), 120);
    const firstGeometry = createJuPedSimGeometry(scenario);
    const secondGeometry = createJuPedSimGeometry(scenario);
    expect(secondGeometry).toEqual(firstGeometry);
    const result = runScenario(scenario);
    expect(result.manifest.engineSpecificProvenance.geometrySha256).toBe(firstGeometry.sha256);
    for (const step of trajectory(result)) {
      expect(step.agents.map((agent) => agent.id))
        .toEqual(scenario.agents.map((agent) => agent.id));
    }
    expect(result.summary.nonFiniteValueOccurred).toBe(false);
  });

  it("keeps corridor centers between the expanded walls and reports directional point goals", () => {
    const scenario = shortened(generateBidirectionalScenario("test", 400, 12), 600);
    const result = runScenario(scenario);
    const lowerWall = Math.min(...scenario.walls.flatMap((wall) => [wall.start[1], wall.end[1]]));
    const upperWall = Math.max(...scenario.walls.flatMap((wall) => [wall.start[1], wall.end[1]]));
    for (const step of trajectory(result)) {
      for (const agent of step.agents) {
        expect(agent.position[1]).toBeGreaterThan(lowerWall);
        expect(agent.position[1]).toBeLessThan(upperWall);
        expect(agent.navigationTarget).toEqual(scenario.agents[agent.id].goal);
      }
    }
    expect(result.metrics.identity.engineId).toBe("jupedsim_sfm_engine_v1");
  });

  it("uses only the shared bottleneck waypoint, blocks exterior bypass, and retains crossers", () => {
    const scenario = generateBottleneckScenario("test", 400, 16);
    const geometry = createJuPedSimGeometry(scenario);
    expect(geometry.spec.excludedWallPolygons).toHaveLength(6);
    expect(geometry.sha256).toBe(createJuPedSimGeometry(scenario).sha256);
    const result = runScenario(scenario);
    const steps = trajectory(result);
    const crossed = new Map<number, number>();
    const priorPositions = new Map(
      scenario.agents.map((agent) => [agent.id, agent.position] as const),
    );
    for (const step of steps) {
      for (const agent of step.agents) {
        const definition = scenario.agents[agent.id];
        const before = priorPositions.get(agent.id);
        if (before === undefined) throw new Error("test lost a bottleneck agent position");
        const expectedTarget = before[0] <= 1 ? [1.5, 0] : definition.goal;
        expect(agent.navigationTarget).toEqual(expectedTarget);
        expect(agent.position[0]).toBeGreaterThan(-14);
        expect(agent.position[0]).toBeLessThan(12);
        expect(agent.position[1]).toBeGreaterThan(-6);
        expect(agent.position[1]).toBeLessThan(6);
        if (before[0] <= 0 && agent.position[0] > 0) {
          const fraction = -before[0] / (agent.position[0] - before[0]);
          const crossingY = before[1] + fraction * (agent.position[1] - before[1]);
          expect(Math.abs(crossingY)).toBeLessThan(1.2);
        }
        if (!crossed.has(agent.id) && agent.position[0] > 8) {
          crossed.set(agent.id, step.stepIndex);
        }
        priorPositions.set(agent.id, agent.position);
      }
    }
    expect(crossed.size).toBeGreaterThan(0);
    for (const [agentId, stepIndex] of crossed) {
      const later = steps[Math.min(stepIndex + 1, steps.length - 1)];
      expect(later.agents.some((agent) => agent.id === agentId)).toBe(true);
    }
  });

  it("records exact version, hashes, license, direct steering, dt, and scenario values", () => {
    const scenario = shortened(loadFixture("free-space"), 2);
    const result = runScenario(scenario);
    const provenance = result.manifest.engineSpecificProvenance;
    expect(result.manifest.upstreamProject).toBe("JuPedSim");
    expect(result.manifest.upstreamLicense).toBe("LGPL-3.0-or-later");
    expect(provenance.jupedsimVersion).toBe("1.4.2");
    expect(provenance.packageWheelSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(provenance.requirementsLockSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(provenance.geometrySha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(provenance.methodConfigSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(provenance.correctionMode).toBe("native_none");
    expect(provenance.directSteering).toBe(true);
    expect(provenance.directSteeringJourneyStageCount).toBe(1);
    expect(provenance.exactDt).toBe(scenario.simulation.dt);
    expect(provenance.completionProtocolVersion).toBe("completion-v2");
    expect(provenance.scenarioProvidedRadii).toEqual([{ id: 0, radius: scenario.agents[0].radius }]);
    expect(provenance.scenarioProvidedPreferredSpeeds)
      .toEqual([{ id: 0, preferredSpeed: scenario.agents[0].preferredSpeed }]);
  });
});

function loadMethod(): JuPedSimSfmMethodConfig {
  return parseMethodConfig(
    JSON.parse(readFileSync(METHOD_PATH, "utf8")) as unknown,
  ) as JuPedSimSfmMethodConfig;
}

function runScenario(scenario: ExperimentScenario): RunExperimentResult {
  const directory = mkdtempSync(resolve(tmpdir(), "jupedsim-baseline-test-"));
  temporaryDirectories.push(directory);
  const scenarioPath = resolve(directory, "scenario.json");
  writeFileSync(scenarioPath, serializeExperimentScenario(scenario), "utf8");
  return runExperiment({
    scenarioPath,
    methodPath: METHOD_PATH,
    outputDirectory: resolve(directory, "run"),
  });
}

function loadFixture(name: string): ExperimentScenario {
  const source = readFileSync(
    resolve("experiments", "baselines", "fixtures", name + ".json"),
    "utf8",
  );
  return parseExperimentScenario(JSON.parse(source) as unknown);
}

function trajectory(result: RunExperimentResult): TrajectoryRecord[] {
  return readFileSync(result.trajectoryPath, "utf8").trim().split(/\r?\n/u).filter(Boolean)
    .map((line) => JSON.parse(line) as TrajectoryRecord);
}

function shortened(scenario: ExperimentScenario, steps: number): ExperimentScenario {
  return {
    ...scenario,
    simulation: {
      ...scenario.simulation,
      horizonSeconds: scenario.simulation.dt * steps,
    },
    agents: scenario.agents.map((agent) => ({
      ...agent,
      position: [...agent.position],
      velocity: [...agent.velocity],
      goal: [...agent.goal],
    })),
    walls: scenario.walls.map((wall) => ({
      ...wall,
      start: [...wall.start],
      end: [...wall.end],
    })),
  };
}
