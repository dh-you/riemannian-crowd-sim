import { norm, sub } from "./math";
import type {
  AgentState,
  ControllerParameters,
  CorrectionParameters,
  SimulationParameters,
  Vec2,
  WallSegment,
} from "./types";
import { CONTROLLER_ID } from "./types";

export function requireFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  return value;
}

export function requireVec2(value: unknown, path: string): Vec2 {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error(`${path} must be a two-element vector`);
  }
  return [requireFiniteNumber(value[0], `${path}[0]`), requireFiniteNumber(value[1], `${path}[1]`)];
}

export function validateControllerParameters(parameters: ControllerParameters): void {
  if (parameters.id !== CONTROLLER_ID) {
    throw new Error(`Unsupported controller id: ${String(parameters.id)}`);
  }
  for (const [name, value] of Object.entries({
    alpha: parameters.alpha,
    sigma: parameters.sigma,
    lambdaR: parameters.lambdaR,
    lambdaT: parameters.lambdaT,
  })) {
    requireFiniteNumber(value, `controller.${name}`);
  }
  if (parameters.alpha < 0) throw new Error("controller.alpha must be nonnegative");
  if (parameters.sigma <= 0) throw new Error("controller.sigma must be positive");
  if (parameters.lambdaR <= 0) throw new Error("controller.lambdaR must be positive");
  if (parameters.lambdaT <= 0) throw new Error("controller.lambdaT must be positive");
}

export function validateCorrectionParameters(parameters: CorrectionParameters): void {
  if (typeof parameters.enabled !== "boolean") throw new Error("correction.enabled must be boolean");
  if (!Number.isSafeInteger(parameters.iterations) || parameters.iterations < 0) {
    throw new Error("correction.iterations must be a nonnegative integer");
  }
  if (parameters.enabled && parameters.iterations < 1) {
    throw new Error("correction.iterations must be at least one when correction is enabled");
  }
  requireFiniteNumber(parameters.padding, "correction.padding");
  if (parameters.padding < 0) throw new Error("correction.padding must be nonnegative");
}

export function validateSimulationParameters(parameters: SimulationParameters): void {
  requireFiniteNumber(parameters.dt, "simulation.dt");
  requireFiniteNumber(parameters.goalTolerance, "simulation.goalTolerance");
  requireFiniteNumber(parameters.velocityTimeConstant, "simulation.velocityTimeConstant");
  if (parameters.dt <= 0) throw new Error("simulation.dt must be positive");
  if (parameters.goalTolerance < 0) throw new Error("simulation.goalTolerance must be nonnegative");
  if (parameters.velocityTimeConstant < 0) {
    throw new Error("simulation.velocityTimeConstant must be nonnegative");
  }
  validateCorrectionParameters(parameters.correction);
}

export function validateAgentStates(agents: readonly AgentState[]): void {
  const ids = new Set<number>();
  for (const [index, agent] of agents.entries()) {
    const path = `agents[${index}]`;
    if (!Number.isSafeInteger(agent.id)) throw new Error(`${path}.id must be a safe integer`);
    if (ids.has(agent.id)) throw new Error(`Duplicate agent id: ${agent.id}`);
    ids.add(agent.id);
    requireVec2(agent.position, `${path}.position`);
    requireVec2(agent.velocity, `${path}.velocity`);
    requireVec2(agent.goal, `${path}.goal`);
    requireFiniteNumber(agent.radius, `${path}.radius`);
    requireFiniteNumber(agent.preferredSpeed, `${path}.preferredSpeed`);
    if (agent.radius <= 0) throw new Error(`${path}.radius must be positive`);
    if (agent.preferredSpeed <= 0) throw new Error(`${path}.preferredSpeed must be positive`);
    if (typeof agent.arrived !== "boolean") throw new Error(`${path}.arrived must be boolean`);
  }
}

export function validateWalls(walls: readonly WallSegment[]): void {
  const ids = new Set<number>();
  for (const [index, wall] of walls.entries()) {
    const path = `walls[${index}]`;
    if (!Number.isSafeInteger(wall.id)) throw new Error(`${path}.id must be a safe integer`);
    if (ids.has(wall.id)) throw new Error(`Duplicate wall id: ${wall.id}`);
    ids.add(wall.id);
    requireVec2(wall.start, `${path}.start`);
    requireVec2(wall.end, `${path}.end`);
    requireFiniteNumber(wall.thickness, `${path}.thickness`);
    if (wall.thickness < 0) throw new Error(`${path}.thickness must be nonnegative`);
    if (norm(sub(wall.end, wall.start)) <= 1e-12) {
      throw new Error(`${path} must have distinct finite endpoints`);
    }
  }
}
