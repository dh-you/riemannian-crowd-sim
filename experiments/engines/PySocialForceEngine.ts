import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { MethodIdentity } from "../protocol/methodIdentity";
import {
  SOCIAL_FORCE_ENGINE_ID,
  SOCIAL_FORCE_METHOD_ID,
  SOCIAL_FORCE_RADIUS_ENGINE_ID,
  SOCIAL_FORCE_RADIUS_METHOD_ID,
  type MethodConfig,
  type RadiusAwareSocialForceMethodConfig,
  type SocialForceMethodConfig,
  type SocialForceParameters,
} from "../protocol/methodConfig";
import type { ExperimentScenario } from "../protocol/schema";
import { protocolNavigationRunnerConfig } from "../protocol/completion";
import { expandThickWalls } from "../baselines/common/wallGeometry";
import { baselineProvenance, baselineRuntimePaths } from "./baselineProvenance";
import type { EngineRunResult, EngineStepSink, ExperimentEngine } from "./ExperimentEngine";
import {
  consumeNativeOutput,
  fixedStepCount,
  makeTemporaryDirectory,
  removeSuccessfulTemporaryDirectory,
  runExternalProcess,
} from "./externalProtocol";

export class PySocialForceEngine implements ExperimentEngine {
  readonly engineId = SOCIAL_FORCE_ENGINE_ID;

  constructor(readonly methodId: string, readonly methodKey: string) {}

  getProvenance() {
    return baselineProvenance("pysocialforce");
  }

  run(
    scenario: ExperimentScenario,
    method: MethodConfig,
    identity: MethodIdentity,
    sink: EngineStepSink,
  ): EngineRunResult {
    if (method.id !== SOCIAL_FORCE_METHOD_ID || identity.methodKey !== this.methodKey) {
      throw new Error("PySocialForce engine received a mismatched method configuration");
    }
    assertHomogeneousRadii(scenario);
    const typed = method as SocialForceMethodConfig;
    const provenance = this.getProvenance();
    const runtime = baselineRuntimePaths();
    const temporaryDirectory = makeTemporaryDirectory(this.engineId, identity.methodKey);
    const inputPath = resolve(temporaryDirectory, "input.json");
    const configPath = resolve(temporaryDirectory, "config.toml");
    const outputPath = resolve(temporaryDirectory, "output.jsonl");
    writeFileSync(configPath, serializeConfig(scenario, typed), "utf8");
    writeFileSync(
      inputPath,
      `${JSON.stringify(createSocialForceInput(scenario, typed, runtime.socialSource, configPath))}\n`,
      "utf8",
    );
    let succeeded = false;
    try {
      runExternalProcess({
        executable: runtime.python,
        arguments: [runtime.socialRunner, "--input", inputPath, "--output", outputPath],
        temporaryDirectory,
        outputPath,
        environment: {
          ...process.env,
          OMP_NUM_THREADS: "1",
          OPENBLAS_NUM_THREADS: "1",
          MKL_NUM_THREADS: "1",
          NUMEXPR_NUM_THREADS: "1",
          PYTHONHASHSEED: "0",
        },
      });
      const finalStates = consumeNativeOutput(scenario, outputPath, "pySocialForce", sink);
      succeeded = true;
      return { finalStates, totalSteps: fixedStepCount(scenario), provenance };
    } finally {
      if (succeeded) removeSuccessfulTemporaryDirectory(temporaryDirectory);
    }
  }
}

export class PySocialForceRadiusEngine implements ExperimentEngine {
  readonly engineId = SOCIAL_FORCE_RADIUS_ENGINE_ID;

  constructor(readonly methodId: string, readonly methodKey: string) {}

  getProvenance(_scenario: ExperimentScenario, method: MethodConfig) {
    if (method.id !== SOCIAL_FORCE_RADIUS_METHOD_ID) {
      throw new Error("Radius-aware PySocialForce provenance received a mismatched method");
    }
    return baselineProvenance("pysocialforce_radius", method.parameters);
  }

  run(
    scenario: ExperimentScenario,
    method: MethodConfig,
    identity: MethodIdentity,
    sink: EngineStepSink,
  ): EngineRunResult {
    if (method.id !== SOCIAL_FORCE_RADIUS_METHOD_ID || identity.methodKey !== this.methodKey) {
      throw new Error("Radius-aware PySocialForce engine received a mismatched method configuration");
    }
    const typed = method as RadiusAwareSocialForceMethodConfig;
    const provenance = this.getProvenance(scenario, method);
    const runtime = baselineRuntimePaths();
    const temporaryDirectory = makeTemporaryDirectory(this.engineId, identity.methodKey);
    const inputPath = resolve(temporaryDirectory, "input.json");
    const configPath = resolve(temporaryDirectory, "config.toml");
    const outputPath = resolve(temporaryDirectory, "output.jsonl");
    writeFileSync(configPath, serializeConfig(scenario, typed), "utf8");
    writeFileSync(
      inputPath,
      `${JSON.stringify(createSocialForceInput(scenario, typed, runtime.socialSource, configPath))}\n`,
      "utf8",
    );
    let succeeded = false;
    try {
      runExternalProcess({
        executable: runtime.python,
        arguments: [runtime.socialRadiusRunner, "--input", inputPath, "--output", outputPath],
        temporaryDirectory,
        outputPath,
        environment: {
          ...process.env,
          OMP_NUM_THREADS: "1",
          OPENBLAS_NUM_THREADS: "1",
          MKL_NUM_THREADS: "1",
          NUMEXPR_NUM_THREADS: "1",
          PYTHONHASHSEED: "0",
        },
      });
      const finalStates = consumeNativeOutput(
        scenario,
        outputPath,
        "pySocialForceRadius",
        sink,
      );
      succeeded = true;
      return { finalStates, totalSteps: fixedStepCount(scenario), provenance };
    } finally {
      if (succeeded) removeSuccessfulTemporaryDirectory(temporaryDirectory);
    }
  }
}

function assertHomogeneousRadii(scenario: ExperimentScenario): void {
  const radius = scenario.agents[0]?.radius;
  if (radius === undefined) throw new Error("PySocialForce requires at least one agent");
  if (scenario.agents.some((agent) => Math.abs(agent.radius - radius) > 1e-12)) {
    throw new Error("Pinned PySocialForce supports only a homogeneous scene-wide pedestrian radius");
  }
}

export function createSocialForceInput(
  scenario: ExperimentScenario,
  method: SocialForceMethodConfig | RadiusAwareSocialForceMethodConfig,
  sourceDirectory: string,
  configPath: string,
) {
  const obstacles = expandThickWalls(scenario.walls).flatMap((polygon) =>
    polygon.vertices.map((start, index) => {
      const end = polygon.vertices[(index + 1) % polygon.vertices.length];
      return [start[0], end[0], start[1], end[1]];
    }),
  );
  return {
    runnerInputVersion: 2,
    sourceDirectory,
    configPath,
    dt: scenario.simulation.dt,
    steps: fixedStepCount(scenario),
    goalTolerance: scenario.simulation.goalTolerance,
    parameters: method.parameters,
    navigation: protocolNavigationRunnerConfig(scenario),
    agents: [...scenario.agents].sort((a, b) => a.id - b.id).map((agent) => ({
      id: agent.id,
      radius: agent.radius,
      preferredSpeed: agent.preferredSpeed,
      position: agent.position,
      velocity: agent.velocity,
      goal: agent.goal,
    })),
    obstacles,
  };
}

function serializeConfig(
  scenario: ExperimentScenario,
  method: { parameters: SocialForceParameters },
): string {
  const radius = scenario.agents[0].radius;
  const parameters = method.parameters;
  return [
    `resolution = ${parameters.obstacleResolution}`,
    `agent_radius = ${radius}`,
    `step_width = ${scenario.simulation.dt}`,
    `max_speed_multiplier = ${parameters.maxSpeedMultiplier}`,
    "tau = 0.5",
    "",
    "[scene]",
    "enable_group = false",
    "",
    "[desired_force]",
    `factor = ${parameters.desiredFactor}`,
    `relaxation_time = ${parameters.relaxationTime}`,
    "goal_threshold = 0.0",
    "",
    "[social_force]",
    `factor = ${parameters.socialFactor}`,
    `lambda_importance = ${parameters.lambdaImportance}`,
    `gamma = ${parameters.gamma}`,
    `n = ${parameters.n}`,
    `n_prime = ${parameters.nPrime}`,
    "",
    "[obstacle_force]",
    `factor = ${parameters.obstacleFactor}`,
    `sigma = ${parameters.obstacleSigma}`,
    `threshold = ${parameters.obstacleThreshold}`,
    "",
  ].join("\n");
}
