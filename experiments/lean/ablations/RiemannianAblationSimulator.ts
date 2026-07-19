import { correctPositions } from "../../../src/core/corrections";
import { measureContacts, requirePosition } from "../../../src/core/diagnostics";
import { add, firstSegmentDiskIntersection, isFiniteVec2, norm, scale, sub } from "../../../src/core/math";
import { smoothingCoefficient } from "../../../src/core/SimulatorCore";
import { SpatialHash } from "../../../src/core/spatialHash";
import type {
  AgentState,
  PerAgentStepDiagnostics,
  StepDiagnostics,
  Vec2,
  WallSegment,
} from "../../../src/core/types";
import {
  validateAgentStates,
  validateSimulationParameters,
  validateWalls,
} from "../../../src/core/validation";
import type { ExperimentScenario } from "../../protocol/schema";
import type { RiemannianAblationConfig } from "./config";
import { RiemannianAblationController } from "./RiemannianAblationController";

const CORRECTION_RATIO_EPSILON_METERS = 1e-12;

/**
 * Study-only synchronous simulator. Its full-gate mode is regression-tested
 * against SimulatorCore; it exists so the production simulator remains frozen.
 */
export class RiemannianAblationSimulator {
  readonly walls: readonly WallSegment[];
  private readonly controller: RiemannianAblationController;
  private agents: AgentState[];
  private nextStepIndex = 0;

  constructor(
    readonly scenario: ExperimentScenario,
    readonly config: RiemannianAblationConfig,
  ) {
    validateAgentStates(scenario.agents);
    validateWalls(scenario.walls);
    validateSimulationParameters({
      dt: scenario.simulation.dt,
      goalTolerance: scenario.simulation.goalTolerance,
      velocityTimeConstant: config.velocityTimeConstant,
      correction: scenario.simulation.correction,
    });
    this.agents = cloneAgents(scenario.agents).sort((first, second) => first.id - second.id);
    this.walls = scenario.walls.map(cloneWall).sort((first, second) => first.id - second.id);
    this.controller = new RiemannianAblationController(config);
  }

  getAgents(): AgentState[] {
    return cloneAgents(this.agents);
  }

  step(): StepDiagnostics {
    const snapshot = cloneAgents(this.agents).sort((first, second) => first.id - second.id);
    const spatialHash = new SpatialHash(this.controller.interactionRadius);
    spatialHash.rebuild(snapshot);

    const targetById = new Map<number, Vec2>();
    const beginsWithinGoalById = new Map<number, boolean>();
    let coincidentNeighborContributionsSkipped = 0;
    for (const agent of snapshot) {
      const control = this.controller.computeControl(
        agent,
        spatialHash.query(agent.position, this.controller.interactionRadius),
        this.scenario.simulation.goalTolerance,
      );
      targetById.set(agent.id, control.targetVelocity);
      beginsWithinGoalById.set(agent.id, control.arrived);
      coincidentNeighborContributionsSkipped += control.coincidentNeighborContributionsSkipped;
    }

    const eta = smoothingCoefficient(
      this.scenario.simulation.dt,
      this.config.velocityTimeConstant,
    );
    const smoothedById = new Map<number, Vec2>();
    const preCorrectionPositions = new Map<number, Vec2>();
    let intendedDisplacement = 0;
    for (const agent of snapshot) {
      const target = requirePosition(targetById, agent.id);
      const beginsWithinGoal = beginsWithinGoalById.get(agent.id) ?? false;
      const smoothed: Vec2 = beginsWithinGoal
        ? [0, 0]
        : add(scale(agent.velocity, eta), scale(target, 1 - eta));
      const proposed = beginsWithinGoal
        ? agent.position
        : add(agent.position, scale(smoothed, this.scenario.simulation.dt));
      const goalIntersection = beginsWithinGoal
        ? agent.position
        : firstSegmentDiskIntersection(
            agent.position,
            proposed,
            agent.goal,
            this.scenario.simulation.goalTolerance,
          );
      const preCorrection = goalIntersection ?? proposed;
      if (!isFiniteVec2(smoothed) || !isFiniteVec2(preCorrection)) {
        throw new Error(`Non-finite ablation integration result for agent ${agent.id}`);
      }
      smoothedById.set(agent.id, smoothed);
      preCorrectionPositions.set(agent.id, preCorrection);
      intendedDisplacement += norm(sub(preCorrection, agent.position));
    }

    const preContacts = measureContacts(snapshot, this.walls, preCorrectionPositions);
    const correction = correctPositions(
      snapshot,
      this.walls,
      preCorrectionPositions,
      this.scenario.simulation.correction,
    );
    const postContacts = measureContacts(snapshot, this.walls, correction.positions);
    const committed: AgentState[] = [];
    const perAgent: PerAgentStepDiagnostics[] = [];
    for (const agent of snapshot) {
      const postCorrectionPosition = requirePosition(correction.positions, agent.id);
      const realizedVelocity = scale(
        sub(postCorrectionPosition, agent.position),
        1 / this.scenario.simulation.dt,
      );
      if (!isFiniteVec2(postCorrectionPosition) || !isFiniteVec2(realizedVelocity)) {
        throw new Error(`Non-finite ablation correction result for agent ${agent.id}`);
      }
      committed.push({
        ...agent,
        position: postCorrectionPosition,
        velocity: realizedVelocity,
        arrived: norm(sub(postCorrectionPosition, agent.goal))
          <= this.scenario.simulation.goalTolerance,
      });
      perAgent.push({
        id: agent.id,
        targetVelocity: requirePosition(targetById, agent.id),
        smoothedVelocity: requirePosition(smoothedById, agent.id),
        realizedVelocity,
        preCorrectionPosition: requirePosition(preCorrectionPositions, agent.id),
        postCorrectionPosition,
        agentCorrectionDisplacement: correction.agentDisplacementById.get(agent.id) ?? 0,
        wallCorrectionDisplacement: correction.wallDisplacementById.get(agent.id) ?? 0,
      });
    }

    const totalCorrectionDisplacement = correction.totalAgentCorrectionDisplacement
      + correction.totalWallCorrectionDisplacement;
    const diagnostic: StepDiagnostics = {
      stepIndex: this.nextStepIndex,
      time: (this.nextStepIndex + 1) * this.scenario.simulation.dt,
      preCorrectionOverlapPairs: preContacts.overlapPairs,
      postCorrectionOverlapPairs: postContacts.overlapPairs,
      preCorrectionWallContacts: preContacts.wallContacts,
      postCorrectionWallContacts: postContacts.wallContacts,
      maxPreCorrectionPenetration: Math.max(
        preContacts.maxAgentPenetration,
        preContacts.maxWallPenetration,
      ),
      maxPostCorrectionPenetration: Math.max(
        postContacts.maxAgentPenetration,
        postContacts.maxWallPenetration,
      ),
      maxPreCorrectionWallPenetration: preContacts.maxWallPenetration,
      maxPostCorrectionWallPenetration: postContacts.maxWallPenetration,
      maximumPreCorrectionAgentPenetration: preContacts.maxAgentPenetration,
      maximumPreCorrectionWallPenetration: preContacts.maxWallPenetration,
      maximumPostCorrectionAgentPenetration: postContacts.maxAgentPenetration,
      maximumPostCorrectionWallPenetration: postContacts.maxWallPenetration,
      totalPreCorrectionOverlapPenetration: preContacts.totalAgentPenetration,
      totalPostCorrectionOverlapPenetration: postContacts.totalAgentPenetration,
      totalPreCorrectionWallPenetration: preContacts.totalWallPenetration,
      totalPostCorrectionWallPenetration: postContacts.totalWallPenetration,
      minimumPreCorrectionClearance: preContacts.minimumClearance,
      minimumPreCorrectionAgentClearance: preContacts.minimumAgentClearance,
      minimumPreCorrectionWallClearance: preContacts.minimumWallClearance,
      correctedAgentPairs: correction.correctedAgentPairs,
      correctedWallContacts: correction.correctedWallContacts,
      intendedDisplacement,
      agentCorrectionDisplacement: correction.totalAgentCorrectionDisplacement,
      wallCorrectionDisplacement: correction.totalWallCorrectionDisplacement,
      totalCorrectionDisplacement,
      correctionRatio: totalCorrectionDisplacement
        / (intendedDisplacement + CORRECTION_RATIO_EPSILON_METERS),
      coincidentNeighborContributionsSkipped,
      perAgent,
    };
    assertFinite(diagnostic, "diagnostic");
    this.agents = committed.sort((first, second) => first.id - second.id);
    this.nextStepIndex += 1;
    return diagnostic;
  }
}

function cloneAgents(agents: readonly AgentState[]): AgentState[] {
  return agents.map((agent) => ({
    ...agent,
    position: [agent.position[0], agent.position[1]],
    velocity: [agent.velocity[0], agent.velocity[1]],
    goal: [agent.goal[0], agent.goal[1]],
  }));
}

function cloneWall(wall: WallSegment): WallSegment {
  return {
    ...wall,
    start: [wall.start[0], wall.start[1]],
    end: [wall.end[0], wall.end[1]],
  };
}

function assertFinite(value: unknown, path: string): void {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error(`Non-finite ablation value at ${path}`);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertFinite(entry, `${path}[${index}]`));
  } else if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) assertFinite(entry, `${path}.${key}`);
  }
}
