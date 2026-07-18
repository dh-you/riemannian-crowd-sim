import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SimulatorCore } from "../../src/core/SimulatorCore";
import { expandThickWall } from "../../experiments/baselines/common/wallGeometry";
import { generateBidirectionalScenario } from "../../experiments/generation/bidirectional";
import { generateBottleneckScenario } from "../../experiments/generation/bottleneck";
import { generateCircleAntipodalScenario } from "../../experiments/generation/circleAntipodal";
import { generateFreeSpaceScenario } from "../../experiments/generation/freeSpace";
import { generatePairwiseScenario } from "../../experiments/generation/pairwise";
import { ScientificCoreEngine } from "../../experiments/engines/ScientificCoreEngine";
import {
  scientificDiagnosticToEngineStep,
  validateEngineStepRecord,
  type EngineStepRecord,
} from "../../experiments/engines/engineStep";
import { runExternalProcess } from "../../experiments/engines/externalProtocol";
import { RunMetricsAccumulator } from "../../experiments/metrics/RunMetricsAccumulator";
import { identifyMethod } from "../../experiments/protocol/methodIdentity";
import {
  controllerParametersFromMethod,
  parseMethodConfig,
  type ScientificMethodConfig,
} from "../../experiments/protocol/methodConfig";
import type { ExperimentScenario } from "../../experiments/protocol/schema";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("common engine-step protocol", () => {
  it("strictly accepts sorted finite records and rejects duplicate IDs and non-finite values", () => {
    const valid = fixtureRecord();
    expect(validateEngineStepRecord(valid)).toBe(valid);
    expect(() => validateEngineStepRecord({
      ...valid,
      agents: [valid.agents[0], { ...valid.agents[0] }],
    })).toThrow(/sorted|unique/u);
    expect(() => validateEngineStepRecord({
      ...valid,
      agents: [{ ...valid.agents[0], commandVelocity: [Number.NaN, 0] }],
    })).toThrow(/finite/u);
    expect(() => validateEngineStepRecord({
      ...valid,
      unexpected: true,
    } as EngineStepRecord)).toThrow(/not allowed/u);
  });

  it("expands finite thick wall segments to deterministic counterclockwise rectangles", () => {
    const polygon = expandThickWall({ id: 7, start: [0, 0], end: [2, 0], thickness: 0.4 });
    expect(polygon.vertices).toEqual([[0, -0.2], [2, -0.2], [2, 0.2], [0, 0.2]]);
    expect(() => expandThickWall({ id: 8, start: [1, 1], end: [1, 1], thickness: 0.2 })).toThrow(/degenerate/u);
    expect(() => expandThickWall({ id: 9, start: [0, 0], end: [1, 0], thickness: 0 })).toThrow(/positive/u);
  });

  it("preserves external stderr and rejects unsuccessful partial output", () => {
    mkdirSync(resolve("experiments", "tmp"), { recursive: true });
    const directory = mkdtempSync(resolve("experiments", "tmp", "mock-engine-failure-"));
    temporaryDirectories.push(directory);
    expect(() => runExternalProcess({
      executable: process.execPath,
      arguments: ["-e", "process.stderr.write('mock native failure'); process.exit(7)"],
      temporaryDirectory: directory,
      outputPath: resolve(directory, "partial.jsonl"),
    })).toThrow(/mock native failure/u);
    const log = resolve(directory, "stderr.log");
    expect(existsSync(log)).toBe(true);
    expect(readFileSync(log, "utf8")).toContain("mock native failure");
  });
});

describe("Scientific Core engine adapter numerical parity", () => {
  it.each(scientificParityScenarios())("matches direct Stage B.1 stepping and metrics for $name", (scenario) => {
    const methodSource = '{"methodConfigVersion":1,"id":"conditioned_riemannian_metric_v1","velocityTimeConstant":0.04,"parameters":{"alpha":10,"sigma":2.4,"lambdaR":10,"lambdaT":1}}\n';
    const method = parseMethodConfig(JSON.parse(methodSource) as unknown) as ScientificMethodConfig;
    const identity = identifyMethod(method, methodSource);
    const directSimulator = new SimulatorCore({
      agents: scenario.agents,
      walls: scenario.walls,
      simulation: {
        dt: scenario.simulation.dt,
        goalTolerance: scenario.simulation.goalTolerance,
        velocityTimeConstant: method.velocityTimeConstant,
        correction: scenario.simulation.correction,
      },
      controller: controllerParametersFromMethod(method),
    });
    const directRecords: EngineStepRecord[] = [];
    const directMetrics = new RunMetricsAccumulator(scenario, {
      ...identity,
      velocityTimeConstant: method.velocityTimeConstant,
      methodParameters: method.parameters,
    });
    for (let step = 0; step < 2; step += 1) {
      const before = directSimulator.getAgents();
      const diagnostic = directSimulator.step();
      const after = directSimulator.getAgents();
      directMetrics.observeStep(before, diagnostic, after);
      directRecords.push(scientificDiagnosticToEngineStep(before, diagnostic, after, "shared_projection"));
    }
    const engine = new ScientificCoreEngine(method.id, identity.methodKey);
    const adaptedRecords: EngineStepRecord[] = [];
    const adaptedMetrics = new RunMetricsAccumulator(scenario, {
      ...identity,
      velocityTimeConstant: method.velocityTimeConstant,
      methodParameters: method.parameters,
    });
    const result = engine.run(scenario, method, identity, (record) => {
      adaptedRecords.push(record);
      adaptedMetrics.observeStep(record);
    });
    expect(adaptedRecords).toEqual(directRecords);
    expect(result.finalStates).toEqual(directSimulator.getAgents());
    expect(adaptedMetrics.finish(result.finalStates)).toEqual(directMetrics.finish(directSimulator.getAgents()));
  });
});

function scientificParityScenarios(): ExperimentScenario[] {
  const scenarios = [
    generateFreeSpaceScenario("test", 0),
    generatePairwiseScenario("head_on", "test", 0),
    generatePairwiseScenario("separating", "test", 0),
    generateCircleAntipodalScenario("test", 0, 8),
    generateBidirectionalScenario("test", 0, 12),
    generateBottleneckScenario("test", 0, 16),
  ];
  return scenarios.map((scenario) => ({
    ...scenario,
    simulation: { ...scenario.simulation, horizonSeconds: scenario.simulation.dt * 2 },
  }));
}

function fixtureRecord(): EngineStepRecord {
  return {
    engineStepVersion: 1,
    stepIndex: 0,
    time: 0.1,
    agents: [{
      id: 0,
      positionBefore: [0, 0],
      velocityBefore: [0, 0],
      preCorrectionPosition: [0.1, 0],
      postCorrectionPosition: [0.1, 0],
      commandVelocity: [1, 0],
      realizedVelocity: [1, 0],
      arrived: false,
    }],
    diagnostics: {
      preCorrectionOverlapPairs: 0,
      postCorrectionOverlapPairs: 0,
      preCorrectionWallContacts: 0,
      postCorrectionWallContacts: 0,
      minimumPreCorrectionAgentClearance: null,
      minimumPreCorrectionWallClearance: null,
      maximumPreCorrectionAgentPenetration: 0,
      maximumPostCorrectionAgentPenetration: 0,
      maximumPreCorrectionWallPenetration: 0,
      maximumPostCorrectionWallPenetration: 0,
      totalPreCorrectionAgentPenetration: 0,
      totalPostCorrectionAgentPenetration: 0,
      totalPreCorrectionWallPenetration: 0,
      totalPostCorrectionWallPenetration: 0,
      intendedDisplacement: 0.1,
      agentCorrectionDisplacement: 0,
      wallCorrectionDisplacement: 0,
      totalCorrectionDisplacement: 0,
      correctionMode: "native_none",
    },
  };
}
