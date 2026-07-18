import type { AgentState, CorrectionParameters, WallSegment } from "../../src/core/types";
import {
  requireFiniteNumber,
  requireVec2,
  validateAgentStates,
  validateCorrectionParameters,
  validateWalls,
} from "../../src/core/validation";
import {
  requireNonemptyIdentifier,
  requireNonemptyString,
  requireSafeInteger,
  requireStrictObject,
} from "./validation";

export const EXPERIMENT_SCENARIO_VERSION = 1 as const;

export interface ExperimentSimulation {
  dt: number;
  horizonSeconds: number;
  goalTolerance: number;
  correction: CorrectionParameters;
}

export interface ExperimentScenario {
  experimentScenarioVersion: typeof EXPERIMENT_SCENARIO_VERSION;
  name: string;
  family: string;
  variant: string;
  split: string;
  seed: number;
  simulation: ExperimentSimulation;
  agents: AgentState[];
  walls: WallSegment[];
  metadata: {
    units: {
      distance: "m";
      time: "s";
    };
  };
}

export function parseExperimentScenario(value: unknown): ExperimentScenario {
  const root = requireStrictObject(value, "experimentScenario", [
    "experimentScenarioVersion",
    "name",
    "family",
    "variant",
    "split",
    "seed",
    "simulation",
    "agents",
    "walls",
    "metadata",
  ]);
  if (root.experimentScenarioVersion !== EXPERIMENT_SCENARIO_VERSION) {
    throw new Error(
      `Unsupported experimentScenarioVersion: ${String(root.experimentScenarioVersion)}`,
    );
  }

  const simulationValue = requireStrictObject(root.simulation, "experimentScenario.simulation", [
    "dt",
    "horizonSeconds",
    "goalTolerance",
    "correction",
  ]);
  const correctionValue = requireStrictObject(
    simulationValue.correction,
    "experimentScenario.simulation.correction",
    ["enabled", "iterations", "padding"],
  );
  if (typeof correctionValue.enabled !== "boolean") {
    throw new Error("experimentScenario.simulation.correction.enabled must be boolean");
  }
  const correction: CorrectionParameters = {
    enabled: correctionValue.enabled,
    iterations: requireSafeInteger(
      correctionValue.iterations,
      "experimentScenario.simulation.correction.iterations",
    ),
    padding: requireFiniteNumber(
      correctionValue.padding,
      "experimentScenario.simulation.correction.padding",
    ),
  };
  validateCorrectionParameters(correction);
  const simulation: ExperimentSimulation = {
    dt: requireFiniteNumber(simulationValue.dt, "experimentScenario.simulation.dt"),
    horizonSeconds: requireFiniteNumber(
      simulationValue.horizonSeconds,
      "experimentScenario.simulation.horizonSeconds",
    ),
    goalTolerance: requireFiniteNumber(
      simulationValue.goalTolerance,
      "experimentScenario.simulation.goalTolerance",
    ),
    correction,
  };
  if (simulation.dt <= 0) throw new Error("experimentScenario.simulation.dt must be positive");
  if (simulation.horizonSeconds < 0) {
    throw new Error("experimentScenario.simulation.horizonSeconds must be nonnegative");
  }
  if (simulation.goalTolerance < 0) {
    throw new Error("experimentScenario.simulation.goalTolerance must be nonnegative");
  }

  if (!Array.isArray(root.agents)) throw new Error("experimentScenario.agents must be an array");
  const agents = root.agents.map((entry, index): AgentState => {
    const path = `experimentScenario.agents[${index}]`;
    const agent = requireStrictObject(entry, path, [
      "id",
      "radius",
      "preferredSpeed",
      "position",
      "velocity",
      "goal",
    ]);
    return {
      id: requireSafeInteger(agent.id, `${path}.id`),
      radius: requireFiniteNumber(agent.radius, `${path}.radius`),
      preferredSpeed: requireFiniteNumber(agent.preferredSpeed, `${path}.preferredSpeed`),
      position: requireVec2(agent.position, `${path}.position`),
      velocity: requireVec2(agent.velocity, `${path}.velocity`),
      goal: requireVec2(agent.goal, `${path}.goal`),
      arrived: false,
    };
  });
  validateAgentStates(agents);

  if (!Array.isArray(root.walls)) throw new Error("experimentScenario.walls must be an array");
  const walls = root.walls.map((entry, index): WallSegment => {
    const path = `experimentScenario.walls[${index}]`;
    const wall = requireStrictObject(entry, path, ["id", "start", "end", "thickness"]);
    return {
      id: requireSafeInteger(wall.id, `${path}.id`),
      start: requireVec2(wall.start, `${path}.start`),
      end: requireVec2(wall.end, `${path}.end`),
      thickness: requireFiniteNumber(wall.thickness, `${path}.thickness`),
    };
  });
  validateWalls(walls);

  const metadata = requireStrictObject(root.metadata, "experimentScenario.metadata", ["units"]);
  const units = requireStrictObject(metadata.units, "experimentScenario.metadata.units", [
    "distance",
    "time",
  ]);
  if (units.distance !== "m" || units.time !== "s") {
    throw new Error("experimentScenario.metadata.units must declare distance 'm' and time 's'");
  }

  return {
    experimentScenarioVersion: EXPERIMENT_SCENARIO_VERSION,
    name: requireNonemptyString(root.name, "experimentScenario.name"),
    family: requireNonemptyIdentifier(root.family, "experimentScenario.family"),
    variant: requireNonemptyIdentifier(root.variant, "experimentScenario.variant"),
    split: requireNonemptyIdentifier(root.split, "experimentScenario.split"),
    seed: requireSafeInteger(root.seed, "experimentScenario.seed"),
    simulation,
    agents: agents.sort((a, b) => a.id - b.id),
    walls: walls.sort((a, b) => a.id - b.id),
    metadata: { units: { distance: "m", time: "s" } },
  };
}

export function serializeExperimentScenario(scenario: ExperimentScenario): string {
  const jsonValue = {
    ...scenario,
    agents: scenario.agents.map(({ arrived: _arrived, ...agent }) => agent),
  };
  return `${JSON.stringify(jsonValue, null, 2)}\n`;
}
