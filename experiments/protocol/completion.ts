import { dot, norm, sub } from "../../src/core/math";
import type { AgentState, Vec2 } from "../../src/core/types";
import type {
  CompletionRule,
  DirectionalLineRule,
  ExperimentScenario,
  ProtocolNavigation,
} from "./schema";

export type CompletionType = "goal_disk" | "directional_line";

export interface CompletionEvent {
  completionType: CompletionType;
  segmentFraction: number;
}

export function completionRuleForAgent(
  scenario: Pick<ExperimentScenario, "completion">,
  agentId: number,
): Exclude<CompletionRule, { type: "per_agent_directional_line" }> {
  const rule = scenario.completion.rule;
  if (rule.type !== "per_agent_directional_line") return rule;
  const selected = rule.rules.find((entry) => entry.agentId === agentId);
  if (selected === undefined) throw new Error(`Completion rule is missing agent ${agentId}`);
  return {
    type: "directional_line",
    axis: selected.axis,
    threshold: selected.threshold,
    direction: selected.direction,
  };
}

export function idealCompletionDistanceForAgent(
  scenario: Pick<ExperimentScenario, "completion">,
  agentId: number,
): number {
  const entry = scenario.completion.idealCompletionDistances.find(
    (candidate) => candidate.agentId === agentId,
  );
  if (entry === undefined) throw new Error(`Ideal completion distance is missing agent ${agentId}`);
  return entry.idealCompletionDistance;
}

export function detectCompletion(
  scenario: Pick<ExperimentScenario, "completion" | "simulation">,
  agent: Pick<AgentState, "id" | "goal">,
  start: Vec2,
  end: Vec2,
): CompletionEvent | null {
  const rule = completionRuleForAgent(scenario, agent.id);
  if (rule.type === "goal_disk") {
    const segmentFraction = firstSegmentDiskIntersectionFraction(
      start,
      end,
      agent.goal,
      scenario.simulation.goalTolerance,
    );
    return segmentFraction === null ? null : { completionType: "goal_disk", segmentFraction };
  }
  const segmentFraction = directionalLineCrossingFraction(start, end, rule);
  return segmentFraction === null
    ? null
    : { completionType: "directional_line", segmentFraction };
}

export function firstSegmentDiskIntersectionFraction(
  start: Vec2,
  end: Vec2,
  center: Vec2,
  radius: number,
): number | null {
  const startRelative = sub(start, center);
  if (pointIsNumericallyInGoalDisk(start, center, radius)) return 0;
  const delta = sub(end, start);
  const a = dot(delta, delta);
  if (a <= 0) return null;
  const b = 2 * dot(startRelative, delta);
  const c = dot(startRelative, startRelative) - radius * radius;
  const discriminant = b * b - 4 * a * c;
  const discriminantScale = Math.max(1, Math.abs(b * b), Math.abs(4 * a * c));
  if (discriminant < -1e-12 * discriminantScale) {
    return pointIsNumericallyInGoalDisk(end, center, radius) ? 1 : null;
  }
  const root = Math.sqrt(Math.max(0, discriminant));
  const candidates = [(-b - root) / (2 * a), (-b + root) / (2 * a)]
    .filter((value) => value >= -1e-12 && value <= 1 + 1e-12)
    .map((value) => Math.max(0, Math.min(1, value)));
  if (candidates.length > 0) return Math.min(...candidates);
  return pointIsNumericallyInGoalDisk(end, center, radius) ? 1 : null;
}

/**
 * Native float32 engines can serialize an analytically truncated boundary
 * point a few representable coordinates outside the disk. A segment endpoint
 * (and that same committed point at the next segment start) within the common
 * position-continuity tolerance is treated as the boundary; line crossings
 * retain exact strict-side semantics.
 */
export function pointIsNumericallyInGoalDisk(point: Vec2, center: Vec2, radius: number): boolean {
  const scale = Math.max(1, radius, ...point.map(Math.abs), ...center.map(Math.abs));
  const tolerance = 2e-7 * scale;
  return norm(sub(point, center)) <= radius + tolerance;
}

export function directionalLineCrossingFraction(
  start: Vec2,
  end: Vec2,
  rule: DirectionalLineRule,
): number | null {
  const axisIndex = rule.axis === "x" ? 0 : 1;
  const before = start[axisIndex];
  const after = end[axisIndex];
  const crosses = rule.direction === "positive"
    ? before < rule.threshold && after > rule.threshold
    : before > rule.threshold && after < rule.threshold;
  if (!crosses) return null;
  return (rule.threshold - before) / (after - before);
}

export function minimumDistanceFromSegmentToPoint(
  start: Vec2,
  end: Vec2,
  point: Vec2,
): number {
  const delta = sub(end, start);
  const denominator = dot(delta, delta);
  if (denominator === 0) return norm(sub(start, point));
  const parameter = Math.max(0, Math.min(1, dot(sub(point, start), delta) / denominator));
  return norm([
    start[0] + parameter * delta[0] - point[0],
    start[1] + parameter * delta[1] - point[1],
  ]);
}

export function resolveProtocolTarget(
  scenario: Pick<ExperimentScenario, "navigation">,
  agent: Pick<AgentState, "position" | "goal">,
): Vec2 {
  return resolveNavigationTarget(scenario.navigation, agent.position, agent.goal);
}

export function resolveNavigationTarget(
  navigation: ProtocolNavigation,
  position: Vec2,
  pointGoal: Vec2,
): Vec2 {
  if (navigation.type === "point_goal") return [pointGoal[0], pointGoal[1]];
  const switchFraction = directionalLineCrossingSide(position, navigation.switchLine);
  return switchFraction ? [pointGoal[0], pointGoal[1]] : [navigation.waypoint[0], navigation.waypoint[1]];
}

export function protocolNavigationRunnerConfig(
  scenario: Pick<ExperimentScenario, "navigation">,
): ProtocolNavigation {
  const navigation = scenario.navigation;
  return navigation.type === "point_goal"
    ? { type: "point_goal" }
    : {
        type: "waypoint_then_point_goal",
        waypoint: [navigation.waypoint[0], navigation.waypoint[1]],
        switchLine: { ...navigation.switchLine },
      };
}

function directionalLineCrossingSide(position: Vec2, rule: DirectionalLineRule): boolean {
  const coordinate = position[rule.axis === "x" ? 0 : 1];
  return rule.direction === "positive"
    ? coordinate > rule.threshold
    : coordinate < rule.threshold;
}
