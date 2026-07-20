import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { MethodIdentity } from "../protocol/methodIdentity";
import {
  ORCA_ENGINE_ID,
  ORCA_METHOD_ID,
  type MethodConfig,
  type OrcaMethodConfig,
} from "../protocol/methodConfig";
import type { ExperimentScenario } from "../protocol/schema";
import { protocolNavigationRunnerConfig } from "../protocol/completion";
import { expandThickWalls } from "../baselines/common/wallGeometry";
import { baselineProvenance, baselineRuntimePaths } from "./baselineProvenance";
import type {
  EngineRunResult,
  EngineStepSink,
  ExperimentEngine,
} from "./ExperimentEngine";
import {
  consumeNativeOutput,
  fixedStepCount,
  makeTemporaryDirectory,
  removeSuccessfulTemporaryDirectory,
  runExternalProcess,
} from "./externalProtocol";

export class OrcaRvo2Engine implements ExperimentEngine {
  readonly engineId = ORCA_ENGINE_ID;

  constructor(readonly methodId: string, readonly methodKey: string) {}

  getProvenance() {
    return baselineProvenance("orca");
  }

  run(
    scenario: ExperimentScenario,
    method: MethodConfig,
    identity: MethodIdentity,
    sink: EngineStepSink,
  ): EngineRunResult {
    if (method.id !== ORCA_METHOD_ID || identity.methodKey !== this.methodKey) {
      throw new Error("ORCA engine received a mismatched method configuration");
    }
    const typed = method as OrcaMethodConfig;
    const provenance = this.getProvenance();
    const runtime = baselineRuntimePaths();
    const temporaryDirectory = makeTemporaryDirectory(this.engineId, identity.methodKey);
    const inputPath = resolve(temporaryDirectory, "input.txt");
    const outputPath = resolve(temporaryDirectory, "output.jsonl");
    writeFileSync(inputPath, serializeOrcaInput(scenario, typed), "utf8");
    let succeeded = false;
    try {
      runExternalProcess({
        executable: runtime.orcaRunner,
        arguments: ["--input", inputPath, "--output", outputPath],
        temporaryDirectory,
        outputPath,
        environment: {
          ...process.env,
          OMP_NUM_THREADS: "1",
        },
      });
      const finalStates = consumeNativeOutput(scenario, outputPath, "orcaRvo2", sink);
      succeeded = true;
      return { finalStates, totalSteps: fixedStepCount(scenario), provenance };
    } finally {
      if (succeeded) removeSuccessfulTemporaryDirectory(temporaryDirectory);
    }
  }
}

export function serializeOrcaInput(scenario: ExperimentScenario, method: OrcaMethodConfig): string {
  const polygons = expandThickWalls(scenario.walls);
  const navigation = protocolNavigationRunnerConfig(scenario);
  const lines = [
    "RVO2_ENGINE_INPUT_V2",
    [
      scenario.simulation.dt,
      fixedStepCount(scenario),
      scenario.simulation.goalTolerance,
      scenario.agents.length,
      polygons.length,
    ].join(" "),
    [
      method.parameters.neighborDist,
      method.parameters.maxNeighbors,
      method.parameters.timeHorizon,
      method.parameters.timeHorizonObst,
    ].join(" "),
    navigation.type === "point_goal"
      ? "NAVIGATION POINT_GOAL"
      : [
          "NAVIGATION",
          "WAYPOINT_THEN_POINT_GOAL",
          navigation.waypoint[0],
          navigation.waypoint[1],
          navigation.switchLine.axis,
          navigation.switchLine.threshold,
          navigation.switchLine.direction,
        ].join(" "),
  ];
  for (const agent of [...scenario.agents].sort((a, b) => a.id - b.id)) {
    lines.push([
      "AGENT", agent.id, agent.radius, agent.preferredSpeed,
      agent.position[0], agent.position[1], agent.velocity[0], agent.velocity[1],
      agent.goal[0], agent.goal[1],
    ].join(" "));
  }
  for (const polygon of polygons) {
    lines.push([
      "POLYGON", polygon.wallId, polygon.vertices.length,
      ...polygon.vertices.flatMap((point) => [point[0], point[1]]),
    ].join(" "));
  }
  return `${lines.join("\n")}\n`;
}
