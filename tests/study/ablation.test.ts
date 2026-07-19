import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RiemannianController } from "../../src/core/RiemannianController";
import { SimulatorCore } from "../../src/core/SimulatorCore";
import type { AgentState } from "../../src/core/types";
import { parseSnapshot } from "../../experiments/audit/cli/evaluateRiemannianSnapshots";
import {
  parseRiemannianAblationConfig,
  RIEMANNIAN_ABLATION_ENGINE_ID,
  RIEMANNIAN_ABLATION_METHOD_ID,
  type RiemannianAblationConfig,
} from "../../experiments/studies/stage-d/ablations/config";
import { RiemannianAblationController } from "../../experiments/studies/stage-d/ablations/RiemannianAblationController";
import { RiemannianAblationSimulator } from "../../experiments/studies/stage-d/ablations/RiemannianAblationSimulator";
import { parseExperimentScenario } from "../../experiments/protocol/schema";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Stage D Riemannian ablation capability", () => {
  it("strictly validates the experiment-only method configuration", () => {
    const parsed = parseRiemannianAblationConfig(fullConfig());
    expect(parsed.id).toBe(RIEMANNIAN_ABLATION_METHOD_ID);
    expect(parsed.engine).toBe(RIEMANNIAN_ABLATION_ENGINE_ID);
    expect(() => parseRiemannianAblationConfig({ ...fullConfig(), unexpected: true }))
      .toThrow(/not allowed/u);
    expect(() => parseRiemannianAblationConfig({
      ...fullConfig(),
      gates: { closing: 1, visibility: true },
    })).toThrow(/boolean/u);
  });

  it("matches the production controller exactly across all 107 D0 snapshots in full mode", () => {
    const lines = readFileSync(
      resolve("experiments/audit/fixtures/riemannian-snapshots.jsonl"),
      "utf8",
    ).trim().split(/\r?\n/u);
    expect(lines).toHaveLength(107);
    for (const [index, line] of lines.entries()) {
      const snapshot = parseSnapshot(JSON.parse(line) as unknown, index + 1);
      const production = new RiemannianController({
        id: "conditioned_riemannian_metric_v1",
        ...snapshot.parameters,
      });
      const ablation = new RiemannianAblationController({
        ...fullConfig(),
        parameters: snapshot.parameters,
      });
      const expectedMetric = production.computeEffectiveMetric(
        snapshot.controlled,
        snapshot.neighbors,
      );
      const actualMetric = ablation.computeEffectiveMetric(
        snapshot.controlled,
        snapshot.neighbors,
      );
      expect(actualMetric, snapshot.caseId).toEqual(expectedMetric);
      expect(
        ablation.computeControl(snapshot.controlled, snapshot.neighbors, snapshot.goalTolerance),
        snapshot.caseId,
      ).toEqual(production.computeControl(
        snapshot.controlled,
        snapshot.neighbors,
        snapshot.goalTolerance,
      ));
    }
  });

  it("reproduces SimulatorCore steps exactly in full mode", () => {
    const scenario = parseExperimentScenario(JSON.parse(readFileSync(
      resolve("experiments/audit/scenarios/pairwise-separating.json"),
      "utf8",
    )) as unknown);
    const config = fullConfig();
    const production = new SimulatorCore({
      agents: scenario.agents,
      walls: scenario.walls,
      simulation: {
        dt: scenario.simulation.dt,
        goalTolerance: scenario.simulation.goalTolerance,
        velocityTimeConstant: config.velocityTimeConstant,
        correction: scenario.simulation.correction,
      },
      controller: { id: "conditioned_riemannian_metric_v1", ...config.parameters },
    });
    const ablation = new RiemannianAblationSimulator(scenario, config);
    for (let index = 0; index < 10; index += 1) {
      expect(ablation.step()).toEqual(production.step());
      expect(ablation.getAgents()).toEqual(production.getAgents());
    }
  });

  it("matches the independent Python reference when both gates are disabled", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "stage-d-ablation-reference-"));
    temporaryDirectories.push(directory);
    const inputPath = resolve(directory, "input.jsonl");
    const outputPath = resolve(directory, "output.jsonl");
    const controlled = agent(0, [0, 0], [1, 0], [10, 0]);
    const neighbor = agent(1, [-1, 0], [-2, 0], [-10, 0]);
    const config = { ...fullConfig(), gates: { closing: false, visibility: false } };
    writeFileSync(inputPath, `${JSON.stringify({
      caseId: "both-gates-disabled",
      parameters: config.parameters,
      gates: config.gates,
      goalTolerance: 0.05,
      controlled,
      neighbors: [neighbor],
    })}\n`, "utf8");
    const result = spawnSync(process.platform === "win32" ? "python" : "python3", [
      resolve("experiments/audit/python/riemannian_reference.py"),
      "--snapshots",
      inputPath,
      "--out",
      outputPath,
    ], { encoding: "utf8" });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const independent = JSON.parse(readFileSync(outputPath, "utf8")) as {
      metric: [[number, number], [number, number]];
      targetVelocity: [number, number];
    };
    const controller = new RiemannianAblationController(config);
    const effective = controller.computeEffectiveMetric(controlled, [neighbor]);
    const actual = controller.computeControl(controlled, [neighbor], 0.05);
    expect(independent.metric[0][0]).toBeCloseTo(effective.metric.xx, 14);
    expect(independent.metric[0][1]).toBeCloseTo(effective.metric.xy, 14);
    expect(independent.metric[1][0]).toBeCloseTo(effective.metric.yx, 14);
    expect(independent.metric[1][1]).toBeCloseTo(effective.metric.yy, 14);
    expect(independent.targetVelocity[0]).toBeCloseTo(actual.targetVelocity[0], 14);
    expect(independent.targetVelocity[1]).toBeCloseTo(actual.targetVelocity[1], 14);
  });
});

function fullConfig(): RiemannianAblationConfig {
  return {
    ablationMethodConfigVersion: 1,
    id: RIEMANNIAN_ABLATION_METHOD_ID,
    engine: RIEMANNIAN_ABLATION_ENGINE_ID,
    velocityTimeConstant: 0.04,
    parameters: { alpha: 10, sigma: 2.4, lambdaR: 10, lambdaT: 1 },
    gates: { closing: true, visibility: true },
  };
}

function agent(
  id: number,
  position: [number, number],
  velocity: [number, number],
  goal: [number, number],
): AgentState {
  return {
    id,
    position,
    velocity,
    goal,
    radius: 0.3,
    preferredSpeed: 1.4,
    arrived: false,
  };
}
