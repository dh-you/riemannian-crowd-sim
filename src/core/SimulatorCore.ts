import { correctPositions } from "./corrections";
import { createMotionController } from "./controllerFactory";
import { measureContacts, requirePosition } from "./diagnostics";
import { add, firstSegmentDiskIntersection, isFiniteVec2, norm, scale, sub } from "./math";
import type { MotionController } from "./MotionController";
import { SpatialHash } from "./spatialHash";
import type {
  AgentState,
  CorrectionParameters,
  PerAgentStepDiagnostics,
  SimulationParameters,
  ScientificControllerParameters,
  StepDiagnostics,
  Vec2,
  WallSegment,
} from "./types";
import {
  validateAgentStates,
  validateScientificControllerParameters,
  validateSimulationParameters,
  validateWalls,
} from "./validation";

export const CORRECTION_RATIO_EPSILON_METERS = 1e-12;

export interface SimulatorCoreOptions {
  agents: readonly AgentState[];
  walls: readonly WallSegment[];
  simulation: SimulationParameters;
  controller: ScientificControllerParameters;
}

export function smoothingCoefficient(dt: number, velocityTimeConstant: number): number {
  if (!Number.isFinite(dt) || dt <= 0) throw new Error("Smoothing dt must be finite and positive");
  if (!Number.isFinite(velocityTimeConstant) || velocityTimeConstant < 0) {
    throw new Error("Velocity time constant must be finite and nonnegative");
  }
  return velocityTimeConstant === 0 ? 0 : Math.exp(-dt / velocityTimeConstant);
}

export class SimulatorCore {
  readonly simulation: SimulationParameters;
  readonly controllerParameters: ScientificControllerParameters;
  readonly walls: readonly WallSegment[];
  private readonly controller: MotionController;
  private agents: AgentState[];
  private nextStepIndex = 0;

  constructor(options: SimulatorCoreOptions) {
    validateAgentStates(options.agents);
    validateWalls(options.walls);
    validateSimulationParameters(options.simulation);
    validateScientificControllerParameters(options.controller);
    this.agents = cloneAgents(options.agents).sort((a, b) => a.id - b.id);
    this.walls = options.walls.map(cloneWall).sort((a, b) => a.id - b.id);
    this.simulation = {
      ...options.simulation,
      correction: { ...options.simulation.correction },
    };
    this.controllerParameters = { ...options.controller };
    this.controller = createMotionController(this.controllerParameters);
  }

  getAgents(): AgentState[] {
    return cloneAgents(this.agents);
  }

  get stepIndex(): number {
    return this.nextStepIndex;
  }

  get time(): number {
    return this.nextStepIndex * this.simulation.dt;
  }

  step(): StepDiagnostics {
    // Every calculation through pre-correction integration reads this one snapshot.
    const snapshot = cloneAgents(this.agents).sort((a, b) => a.id - b.id);
    const spatialHash =
      this.controller.interactionRadius > 0
        ? new SpatialHash(this.controller.interactionRadius)
        : null;
    spatialHash?.rebuild(snapshot);

    const targetById = new Map<number, Vec2>();
    const beginsWithinGoalById = new Map<number, boolean>();
    let coincidentNeighborContributionsSkipped = 0;
    for (const agent of snapshot) {
      const controlResult = this.controller.computeControl(
        agent,
        spatialHash?.query(agent.position, this.controller.interactionRadius) ?? [],
        this.simulation.goalTolerance,
      );
      coincidentNeighborContributionsSkipped +=
        controlResult.coincidentNeighborContributionsSkipped;
      targetById.set(agent.id, controlResult.targetVelocity);
      beginsWithinGoalById.set(agent.id, controlResult.arrived);
    }

    const eta = smoothingCoefficient(this.simulation.dt, this.simulation.velocityTimeConstant);
    const smoothedById = new Map<number, Vec2>();
    const preCorrectionPositions = new Map<number, Vec2>();
    let intendedDisplacement = 0;
    for (const agent of snapshot) {
      const target = requirePosition(targetById, agent.id);
      const beginsWithinGoal = beginsWithinGoalById.get(agent.id) ?? false;
      const smoothed: Vec2 = beginsWithinGoal
        ? [0, 0]
        : add(scale(agent.velocity, eta), scale(target, 1 - eta));
      const proposedPosition = beginsWithinGoal
        ? agent.position
        : add(agent.position, scale(smoothed, this.simulation.dt));
      const goalIntersection = beginsWithinGoal
        ? agent.position
        : firstSegmentDiskIntersection(
            agent.position,
            proposedPosition,
            agent.goal,
            this.simulation.goalTolerance,
          );
      const preCorrectionPosition = goalIntersection ?? proposedPosition;
      if (!isFiniteVec2(smoothed) || !isFiniteVec2(preCorrectionPosition)) {
        throw new Error(`Non-finite integration result for agent ${agent.id}`);
      }
      smoothedById.set(agent.id, smoothed);
      preCorrectionPositions.set(agent.id, preCorrectionPosition);
      intendedDisplacement += norm(sub(preCorrectionPosition, agent.position));
    }

    const preCorrection = measureContacts(snapshot, this.walls, preCorrectionPositions);
    const correction = correctPositions(
      snapshot,
      this.walls,
      preCorrectionPositions,
      this.simulation.correction,
    );
    const postCorrection = measureContacts(snapshot, this.walls, correction.positions);

    const committed: AgentState[] = [];
    const perAgent: PerAgentStepDiagnostics[] = [];
    for (const agent of snapshot) {
      const postCorrectionPosition = requirePosition(correction.positions, agent.id);
      const realizedVelocity = scale(sub(postCorrectionPosition, agent.position), 1 / this.simulation.dt);
      if (!isFiniteVec2(postCorrectionPosition) || !isFiniteVec2(realizedVelocity)) {
        throw new Error(`Non-finite corrected result for agent ${agent.id}`);
      }
      committed.push({
        ...agent,
        position: postCorrectionPosition,
        velocity: realizedVelocity,
        arrived: norm(sub(postCorrectionPosition, agent.goal)) <= this.simulation.goalTolerance,
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

    const totalCorrectionDisplacement =
      correction.totalAgentCorrectionDisplacement + correction.totalWallCorrectionDisplacement;
    const diagnostic: StepDiagnostics = {
      stepIndex: this.nextStepIndex,
      time: (this.nextStepIndex + 1) * this.simulation.dt,
      preCorrectionOverlapPairs: preCorrection.overlapPairs,
      postCorrectionOverlapPairs: postCorrection.overlapPairs,
      preCorrectionWallContacts: preCorrection.wallContacts,
      postCorrectionWallContacts: postCorrection.wallContacts,
      maxPreCorrectionPenetration: Math.max(
        preCorrection.maxAgentPenetration,
        preCorrection.maxWallPenetration,
      ),
      maxPostCorrectionPenetration: Math.max(
        postCorrection.maxAgentPenetration,
        postCorrection.maxWallPenetration,
      ),
      maxPreCorrectionWallPenetration: preCorrection.maxWallPenetration,
      maxPostCorrectionWallPenetration: postCorrection.maxWallPenetration,
      totalPreCorrectionOverlapPenetration: preCorrection.totalAgentPenetration,
      totalPostCorrectionOverlapPenetration: postCorrection.totalAgentPenetration,
      totalPreCorrectionWallPenetration: preCorrection.totalWallPenetration,
      totalPostCorrectionWallPenetration: postCorrection.totalWallPenetration,
      minimumPreCorrectionClearance: preCorrection.minimumClearance,
      correctedAgentPairs: correction.correctedAgentPairs,
      correctedWallContacts: correction.correctedWallContacts,
      intendedDisplacement,
      agentCorrectionDisplacement: correction.totalAgentCorrectionDisplacement,
      wallCorrectionDisplacement: correction.totalWallCorrectionDisplacement,
      totalCorrectionDisplacement,
      correctionRatio: totalCorrectionDisplacement / (intendedDisplacement + CORRECTION_RATIO_EPSILON_METERS),
      coincidentNeighborContributionsSkipped,
      perAgent,
    };
    assertFiniteStep(diagnostic);
    this.agents = committed.sort((a, b) => a.id - b.id);
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

function assertFiniteStep(diagnostic: StepDiagnostics): void {
  const visit = (value: unknown, path: string): void => {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`Non-finite diagnostic value at ${path}`);
    }
    if (Array.isArray(value)) value.forEach((entry, index) => visit(entry, `${path}[${index}]`));
    else if (value !== null && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) visit(entry, `${path}.${key}`);
    }
  };
  visit(diagnostic, "diagnostic");
}

export function correctionDisabled(): CorrectionParameters {
  return { enabled: false, iterations: 0, padding: 0 };
}
