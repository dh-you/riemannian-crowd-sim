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

export const EXPERIMENT_SCENARIO_VERSION = 2 as const;
export const LEGACY_EXPERIMENT_SCENARIO_VERSION = 1 as const;

export type Axis = "x" | "y";
export type CrossingDirection = "positive" | "negative";

export interface DirectionalLineRule {
  type: "directional_line";
  axis: Axis;
  threshold: number;
  direction: CrossingDirection;
}

export type CompletionRule =
  | { type: "goal_disk" }
  | DirectionalLineRule
  | {
      type: "per_agent_directional_line";
      rules: Array<{ agentId: number; axis: Axis; threshold: number; direction: CrossingDirection }>;
    };

export interface ScenarioCompletion {
  completionSpecVersion: 1;
  rule: CompletionRule;
  idealCompletionDistances: Array<{ agentId: number; idealCompletionDistance: number }>;
}

export type ProtocolNavigation =
  | { type: "point_goal" }
  | {
      type: "waypoint_then_point_goal";
      waypoint: import("../../src/core/types").Vec2;
      switchLine: DirectionalLineRule;
    };

export interface ExperimentSimulation {
  dt: number;
  horizonSeconds: number;
  goalTolerance: number;
  correction: CorrectionParameters;
}

export interface ExperimentScenario {
  experimentScenarioVersion:
    | typeof EXPERIMENT_SCENARIO_VERSION
    | typeof LEGACY_EXPERIMENT_SCENARIO_VERSION;
  name: string;
  family: string;
  variant: string;
  split: string;
  seed: number;
  simulation: ExperimentSimulation;
  agents: AgentState[];
  walls: WallSegment[];
  completion: ScenarioCompletion;
  navigation: ProtocolNavigation;
  metadata: {
    units: {
      distance: "m";
      time: "s";
    };
  };
}

export function parseExperimentScenario(value: unknown): ExperimentScenario {
  const rawVersion = value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>).experimentScenarioVersion
    : undefined;
  const isLegacy = rawVersion === LEGACY_EXPERIMENT_SCENARIO_VERSION;
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
    ...(isLegacy ? [] : ["completion", "navigation"]),
    "metadata",
  ]);
  if (
    root.experimentScenarioVersion !== EXPERIMENT_SCENARIO_VERSION
    && root.experimentScenarioVersion !== LEGACY_EXPERIMENT_SCENARIO_VERSION
  ) {
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

  const completion = isLegacy
    ? legacyGoalDiskCompletion(agents, simulation.goalTolerance)
    : parseScenarioCompletion(root.completion, agents);
  const navigation = isLegacy
    ? { type: "point_goal" } as const
    : parseProtocolNavigation(root.navigation);

  const metadata = requireStrictObject(root.metadata, "experimentScenario.metadata", ["units"]);
  const units = requireStrictObject(metadata.units, "experimentScenario.metadata.units", [
    "distance",
    "time",
  ]);
  if (units.distance !== "m" || units.time !== "s") {
    throw new Error("experimentScenario.metadata.units must declare distance 'm' and time 's'");
  }

  return {
    experimentScenarioVersion: root.experimentScenarioVersion as 1 | 2,
    name: requireNonemptyString(root.name, "experimentScenario.name"),
    family: requireNonemptyIdentifier(root.family, "experimentScenario.family"),
    variant: requireNonemptyIdentifier(root.variant, "experimentScenario.variant"),
    split: requireNonemptyIdentifier(root.split, "experimentScenario.split"),
    seed: requireSafeInteger(root.seed, "experimentScenario.seed"),
    simulation,
    agents: agents.sort((a, b) => a.id - b.id),
    walls: walls.sort((a, b) => a.id - b.id),
    completion,
    navigation,
    metadata: { units: { distance: "m", time: "s" } },
  };
}

export function serializeExperimentScenario(scenario: ExperimentScenario): string {
  const { completion, navigation, ...physicalScenario } = scenario;
  const jsonValue = scenario.experimentScenarioVersion === LEGACY_EXPERIMENT_SCENARIO_VERSION
    ? {
        ...physicalScenario,
        agents: scenario.agents.map(({ arrived: _arrived, ...agent }) => agent),
      }
    : {
        ...physicalScenario,
        agents: scenario.agents.map(({ arrived: _arrived, ...agent }) => agent),
        completion,
        navigation,
      };
  return `${JSON.stringify(jsonValue, null, 2)}\n`;
}

function parseScenarioCompletion(value: unknown, agents: readonly AgentState[]): ScenarioCompletion {
  const root = requireStrictObject(value, "experimentScenario.completion", [
    "completionSpecVersion",
    "rule",
    "idealCompletionDistances",
  ]);
  if (root.completionSpecVersion !== 1) throw new Error("Unsupported completionSpecVersion");
  const rule = parseCompletionRule(root.rule, agents);
  if (!Array.isArray(root.idealCompletionDistances)) {
    throw new Error("experimentScenario.completion.idealCompletionDistances must be an array");
  }
  const idealCompletionDistances = root.idealCompletionDistances.map((value_, index) => {
    const path = `experimentScenario.completion.idealCompletionDistances[${index}]`;
    const entry = requireStrictObject(value_, path, ["agentId", "idealCompletionDistance"]);
    const idealCompletionDistance = requireFiniteNumber(
      entry.idealCompletionDistance,
      `${path}.idealCompletionDistance`,
    );
    if (idealCompletionDistance < 0) throw new Error(`${path}.idealCompletionDistance must be nonnegative`);
    return {
      agentId: requireSafeInteger(entry.agentId, `${path}.agentId`),
      idealCompletionDistance,
    };
  }).sort((a, b) => a.agentId - b.agentId);
  requireExactAgentIds(
    idealCompletionDistances.map(({ agentId }) => agentId),
    agents,
    "ideal completion distances",
  );
  return { completionSpecVersion: 1, rule, idealCompletionDistances };
}

function parseCompletionRule(value: unknown, agents: readonly AgentState[]): CompletionRule {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("experimentScenario.completion.rule must be an object");
  }
  const type = (value as Record<string, unknown>).type;
  if (type === "goal_disk") {
    requireStrictObject(value, "experimentScenario.completion.rule", ["type"]);
    return { type };
  }
  if (type === "directional_line") {
    return parseDirectionalLine(value, "experimentScenario.completion.rule");
  }
  if (type === "per_agent_directional_line") {
    const root = requireStrictObject(value, "experimentScenario.completion.rule", ["type", "rules"]);
    if (!Array.isArray(root.rules)) throw new Error("per-agent completion rules must be an array");
    const rules = root.rules.map((entry, index) => {
      const path = `experimentScenario.completion.rule.rules[${index}]`;
      const parsed = requireStrictObject(entry, path, ["agentId", "axis", "threshold", "direction"]);
      const line = parseDirectionalLine({
        type: "directional_line",
        axis: parsed.axis,
        threshold: parsed.threshold,
        direction: parsed.direction,
      }, path);
      return {
        agentId: requireSafeInteger(parsed.agentId, `${path}.agentId`),
        axis: line.axis,
        threshold: line.threshold,
        direction: line.direction,
      };
    }).sort((a, b) => a.agentId - b.agentId);
    requireExactAgentIds(rules.map(({ agentId }) => agentId), agents, "per-agent completion rules");
    return { type, rules };
  }
  throw new Error(`Unsupported completion rule type: ${String(type)}`);
}

function parseDirectionalLine(value: unknown, path: string): DirectionalLineRule {
  const root = requireStrictObject(value, path, ["type", "axis", "threshold", "direction"]);
  if (root.type !== "directional_line") throw new Error(`${path}.type must be directional_line`);
  if (root.axis !== "x" && root.axis !== "y") throw new Error(`${path}.axis must be x or y`);
  if (root.direction !== "positive" && root.direction !== "negative") {
    throw new Error(`${path}.direction must be positive or negative`);
  }
  return {
    type: "directional_line",
    axis: root.axis,
    threshold: requireFiniteNumber(root.threshold, `${path}.threshold`),
    direction: root.direction,
  };
}

function parseProtocolNavigation(value: unknown): ProtocolNavigation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("experimentScenario.navigation must be an object");
  }
  const type = (value as Record<string, unknown>).type;
  if (type === "point_goal") {
    requireStrictObject(value, "experimentScenario.navigation", ["type"]);
    return { type };
  }
  if (type !== "waypoint_then_point_goal") {
    throw new Error(`Unsupported navigation type: ${String(type)}`);
  }
  const root = requireStrictObject(value, "experimentScenario.navigation", [
    "type",
    "waypoint",
    "switchLine",
  ]);
  return {
    type,
    waypoint: requireVec2(root.waypoint, "experimentScenario.navigation.waypoint"),
    switchLine: parseDirectionalLine(root.switchLine, "experimentScenario.navigation.switchLine"),
  };
}

function legacyGoalDiskCompletion(
  agents: readonly AgentState[],
  goalTolerance: number,
): ScenarioCompletion {
  return {
    completionSpecVersion: 1,
    rule: { type: "goal_disk" },
    idealCompletionDistances: agents.map((agent) => ({
      agentId: agent.id,
      idealCompletionDistance: Math.max(
        0,
        Math.hypot(agent.goal[0] - agent.position[0], agent.goal[1] - agent.position[1])
          - goalTolerance,
      ),
    })),
  };
}

function requireExactAgentIds(
  ids: readonly number[],
  agents: readonly AgentState[],
  label: string,
): void {
  const expected = [...agents].map(({ id }) => id).sort((a, b) => a - b);
  const actual = [...ids].sort((a, b) => a - b);
  if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
    throw new Error(`Scenario ${label} must contain each agent ID exactly once`);
  }
}
