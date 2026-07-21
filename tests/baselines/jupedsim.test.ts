import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createJuPedSimGeometry } from "../../experiments/baselines/jupedsim/geometry";
import { runExperiment, type RunExperimentResult } from "../../experiments/cli/runExperiment";
import type { EngineStepRecord } from "../../experiments/engines/engineStep";
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
import { runAuditedEngine } from "../../experiments/lean/audit/auditRun";
import type { RunMetrics } from "../../experiments/metrics/types";

const temporaryDirectories: string[] = [];
const METHOD_PATH = resolve("experiments", "methods", "jupedsim-sfm-default.json");
const GOAL_METHOD_PATH = resolve("experiments", "methods", "goal-projection.json");

interface StabilityDiagnostic {
  experimentDt: number;
  nativeJuPedSimDt: number;
  nativeSubstepsPerExperimentStep: number;
  nativeIterationCount: number;
  protocolTargetResolutionCount: number;
  targetAssignmentCount: number;
  targetHeldAcrossNativeSubsteps: boolean;
  peakNativeSpeedMetersPerSecond: { value: number };
  peakNativeAccelerationMetersPerSecondSquared: { value: number };
  minimumArtificialOuterBoundaryClearanceMeters: number;
}

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

  it("stabilizes circle N=50 seed 107 at the unchanged outer clock and fixed geometry", () => {
    const scenario = generateCircleAntipodalScenario("test", 107, 50);
    const scenarioBytes = serializeExperimentScenario(scenario);
    const geometry = createJuPedSimGeometry(scenario);
    expect(geometry.spec.margin).toBe(5);
    const result = runAuditedScenario(scenario);
    expect(result.steps).toHaveLength(1800);
    expect(result.steps.at(-1)?.time).toBe(30);
    expect(result.metrics.completion.successFraction).toBe(1);
    expect(JSON.stringify(result.steps)).not.toMatch(/NaN|Infinity/u);
    const diagnostic = stabilityDiagnostic(result.manifest);
    expect(diagnostic.peakNativeSpeedMetersPerSecond.value).toBeLessThan(5);
    expect(diagnostic.peakNativeAccelerationMetersPerSecondSquared.value).toBeLessThan(500);
    expect(diagnostic.minimumArtificialOuterBoundaryClearanceMeters).toBeGreaterThan(0);
    const [lowerLeft, , upperRight] = geometry.spec.outerPolygon;
    for (const step of result.steps) {
      for (const agent of step.agents) {
        expect(agent.postCorrectionPosition[0]).toBeGreaterThan(lowerLeft[0]);
        expect(agent.postCorrectionPosition[0]).toBeLessThan(upperRight[0]);
        expect(agent.postCorrectionPosition[1]).toBeGreaterThan(lowerLeft[1]);
        expect(agent.postCorrectionPosition[1]).toBeLessThan(upperRight[1]);
      }
    }
    expect(serializeExperimentScenario(scenario)).toBe(scenarioBytes);
    expect(createJuPedSimGeometry(scenario)).toEqual(geometry);
  });

  it("emits one outer record after exactly two held-target native substeps", () => {
    const scenario = shortened(loadFixture("free-space"), 12);
    const scenarioBytes = serializeExperimentScenario(scenario);
    const method = loadMethod();
    const input = createJuPedSimInput(scenario, method);
    const result = runAuditedScenario(scenario);
    const diagnostic = stabilityDiagnostic(result.manifest);
    expect(diagnostic.experimentDt).toBe(scenario.simulation.dt);
    expect(diagnostic.nativeJuPedSimDt).toBe(scenario.simulation.dt / 2);
    expect(diagnostic.nativeSubstepsPerExperimentStep).toBe(2);
    expect(diagnostic.nativeIterationCount).toBe(24);
    expect(diagnostic.protocolTargetResolutionCount).toBe(12);
    expect(diagnostic.targetAssignmentCount).toBe(12);
    expect(diagnostic.targetHeldAcrossNativeSubsteps).toBe(true);
    expect(result.steps.map((step) => step.stepIndex)).toEqual(
      Array.from({ length: 12 }, (_, index) => index),
    );
    expect(result.steps.map((step) => step.time)).toEqual(
      Array.from({ length: 12 }, (_, index) => (index + 1) * scenario.simulation.dt),
    );
    for (const step of result.steps) {
      const agent = step.agents[0];
      expect(agent.navigationTarget).toEqual(scenario.agents[0].goal);
      expect(agent.realizedVelocity[0]).toBeCloseTo(
        (agent.postCorrectionPosition[0] - agent.positionBefore[0]) / scenario.simulation.dt,
        12,
      );
      expect(agent.realizedVelocity[1]).toBeCloseTo(
        (agent.postCorrectionPosition[1] - agent.positionBefore[1]) / scenario.simulation.dt,
        12,
      );
    }
    expect(input.parameters).toEqual(method.parameters);
    expect(input.geometry.margin).toBe(5);
    expect(input.agents[0].radius).toBe(scenario.agents[0].radius);
    expect(input.agents[0].preferredSpeed).toBe(scenario.agents[0].preferredSpeed);
    expect(input.navigation).toEqual({ type: "point_goal" });
    expect(input.steps * input.dt).toBe(scenario.simulation.horizonSeconds);
    expect(serializeExperimentScenario(scenario)).toBe(scenarioBytes);
  });

  it("does not alter non-JuPedSim scientific output", () => {
    const scenario = shortened(generatePairwiseScenario("crossing", "test", 19), 24);
    const first = runScenario(scenario, GOAL_METHOD_PATH);
    createJuPedSimInput(scenario, loadMethod());
    const second = runScenario(scenario, GOAL_METHOD_PATH);
    expect(readFileSync(second.trajectoryPath, "utf8"))
      .toBe(readFileSync(first.trajectoryPath, "utf8"));
    expect(second.metrics).toEqual(first.metrics);
    expect(second.manifest.engineArtifactDiagnostics).toBeUndefined();
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
    expect(provenance.experimentDt).toBe(scenario.simulation.dt);
    expect(provenance.nativeJuPedSimDt).toBe(scenario.simulation.dt / 2);
    expect(provenance.nativeSubstepsPerExperimentStep).toBe(2);
    expect(provenance.internalIntegrationDescription)
      .toMatch(/deterministic internal integration substepping/u);
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

function runScenario(
  scenario: ExperimentScenario,
  methodPath = METHOD_PATH,
): RunExperimentResult {
  const directory = mkdtempSync(resolve(tmpdir(), "jupedsim-baseline-test-"));
  temporaryDirectories.push(directory);
  const scenarioPath = resolve(directory, "scenario.json");
  writeFileSync(scenarioPath, serializeExperimentScenario(scenario), "utf8");
  return runExperiment({
    scenarioPath,
    methodPath,
    outputDirectory: resolve(directory, "run"),
  });
}

function runAuditedScenario(scenario: ExperimentScenario): {
  steps: EngineStepRecord[];
  metrics: RunMetrics;
  manifest: Record<string, unknown>;
} {
  const directory = mkdtempSync(resolve(tmpdir(), "jupedsim-audit-test-"));
  temporaryDirectories.push(directory);
  const scenarioPath = resolve(directory, "scenario.json");
  writeFileSync(scenarioPath, serializeExperimentScenario(scenario), "utf8");
  const artifacts = runAuditedEngine(
    scenarioPath,
    METHOD_PATH,
    resolve(directory, "run"),
  );
  return {
    steps: readFileSync(artifacts.trajectoryPath, "utf8").trim().split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as EngineStepRecord),
    metrics: JSON.parse(readFileSync(artifacts.metricsPath, "utf8")) as RunMetrics,
    manifest: JSON.parse(readFileSync(artifacts.manifestPath, "utf8")) as Record<string, unknown>,
  };
}

function stabilityDiagnostic(manifest: Record<string, unknown>): StabilityDiagnostic {
  const artifacts = manifest.engineArtifactDiagnostics;
  if (artifacts === null || typeof artifacts !== "object" || Array.isArray(artifacts)) {
    throw new Error("missing JuPedSim artifact diagnostics");
  }
  const diagnostic = (artifacts as Record<string, unknown>).numericalStability;
  if (diagnostic === null || typeof diagnostic !== "object" || Array.isArray(diagnostic)) {
    throw new Error("missing JuPedSim numerical-stability diagnostic");
  }
  return diagnostic as unknown as StabilityDiagnostic;
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
