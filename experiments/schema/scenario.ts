import type {
  AgentState,
  ControllerParameters,
  SimulationParameters,
  WallSegment,
} from "../../src/core/types";
import { CONTROLLER_ID } from "../../src/core/types";
import {
  requireFiniteNumber,
  requireVec2,
  validateAgentStates,
  validateControllerParameters,
  validateSimulationParameters,
  validateWalls,
} from "../../src/core/validation";

export const SCENARIO_SCHEMA_VERSION = 1 as const;

export interface ScenarioSimulation extends SimulationParameters {
  horizonSeconds: number;
  recordingInterval?: number;
}

export interface Scenario {
  schemaVersion: typeof SCENARIO_SCHEMA_VERSION;
  name: string;
  seed: number;
  simulation: ScenarioSimulation;
  controller: ControllerParameters;
  agents: AgentState[];
  walls: WallSegment[];
}

export function parseScenario(value: unknown): Scenario {
  const root = requireObject(value, "scenario");
  if (root.schemaVersion !== SCENARIO_SCHEMA_VERSION) {
    throw new Error(`Unsupported scenario schemaVersion: ${String(root.schemaVersion)}`);
  }
  if (typeof root.name !== "string" || root.name.trim().length === 0) {
    throw new Error("scenario.name must be a nonempty string");
  }
  const seed = requireFiniteNumber(root.seed, "scenario.seed");
  if (!Number.isSafeInteger(seed)) throw new Error("scenario.seed must be a safe integer");

  const simulationValue = requireObject(root.simulation, "scenario.simulation");
  const correctionValue = requireObject(
    simulationValue.correction,
    "scenario.simulation.correction",
  );
  if (typeof correctionValue.enabled !== "boolean") {
    throw new Error("scenario.simulation.correction.enabled must be boolean");
  }
  const iterations = requireFiniteNumber(
    correctionValue.iterations,
    "scenario.simulation.correction.iterations",
  );
  const simulation: ScenarioSimulation = {
    dt: requireFiniteNumber(simulationValue.dt, "scenario.simulation.dt"),
    horizonSeconds: requireFiniteNumber(
      simulationValue.horizonSeconds,
      "scenario.simulation.horizonSeconds",
    ),
    goalTolerance: requireFiniteNumber(
      simulationValue.goalTolerance,
      "scenario.simulation.goalTolerance",
    ),
    velocityTimeConstant: requireFiniteNumber(
      simulationValue.velocityTimeConstant,
      "scenario.simulation.velocityTimeConstant",
    ),
    correction: {
      enabled: correctionValue.enabled,
      iterations,
      padding: requireFiniteNumber(
        correctionValue.padding,
        "scenario.simulation.correction.padding",
      ),
    },
  };
  if (simulationValue.recordingInterval !== undefined) {
    const recordingInterval = requireFiniteNumber(
      simulationValue.recordingInterval,
      "scenario.simulation.recordingInterval",
    );
    if (!Number.isSafeInteger(recordingInterval) || recordingInterval < 1) {
      throw new Error("scenario.simulation.recordingInterval must be a positive integer");
    }
    simulation.recordingInterval = recordingInterval;
  }
  validateSimulationParameters(simulation);
  if (simulation.horizonSeconds < 0) {
    throw new Error("scenario.simulation.horizonSeconds must be nonnegative");
  }

  const controllerValue = requireObject(root.controller, "scenario.controller");
  if (controllerValue.id !== CONTROLLER_ID) {
    throw new Error(`Unsupported controller id: ${String(controllerValue.id)}`);
  }
  const controller: ControllerParameters = {
    id: CONTROLLER_ID,
    alpha: requireFiniteNumber(controllerValue.alpha, "scenario.controller.alpha"),
    sigma: requireFiniteNumber(controllerValue.sigma, "scenario.controller.sigma"),
    lambdaR: requireFiniteNumber(controllerValue.lambdaR, "scenario.controller.lambdaR"),
    lambdaT: requireFiniteNumber(controllerValue.lambdaT, "scenario.controller.lambdaT"),
  };
  validateControllerParameters(controller);

  if (!Array.isArray(root.agents)) throw new Error("scenario.agents must be an array");
  const agents = root.agents.map((entry, index): AgentState => {
    const agent = requireObject(entry, `scenario.agents[${index}]`);
    const id = requireFiniteNumber(agent.id, `scenario.agents[${index}].id`);
    return {
      id,
      radius: requireFiniteNumber(agent.radius, `scenario.agents[${index}].radius`),
      preferredSpeed: requireFiniteNumber(
        agent.preferredSpeed,
        `scenario.agents[${index}].preferredSpeed`,
      ),
      position: requireVec2(agent.position, `scenario.agents[${index}].position`),
      velocity: requireVec2(agent.velocity, `scenario.agents[${index}].velocity`),
      goal: requireVec2(agent.goal, `scenario.agents[${index}].goal`),
      arrived: parseOptionalBoolean(agent.arrived, false, `scenario.agents[${index}].arrived`),
    };
  });
  validateAgentStates(agents);

  if (!Array.isArray(root.walls)) throw new Error("scenario.walls must be an array");
  const walls = root.walls.map((entry, index): WallSegment => {
    const wall = requireObject(entry, `scenario.walls[${index}]`);
    return {
      id: requireFiniteNumber(wall.id, `scenario.walls[${index}].id`),
      start: requireVec2(wall.start, `scenario.walls[${index}].start`),
      end: requireVec2(wall.end, `scenario.walls[${index}].end`),
      thickness: requireFiniteNumber(wall.thickness, `scenario.walls[${index}].thickness`),
    };
  });
  validateWalls(walls);

  return {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    name: root.name,
    seed,
    simulation,
    controller,
    agents,
    walls,
  };
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseOptionalBoolean(value: unknown, fallback: boolean, path: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${path} must be boolean when provided`);
  return value;
}
