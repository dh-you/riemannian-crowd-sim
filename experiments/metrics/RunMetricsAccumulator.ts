import { dot, norm, scale, sub } from "../../src/core/math";
import { CORRECTION_RATIO_EPSILON_METERS } from "../../src/core/SimulatorCore";
import type { AgentState, StepDiagnostics, Vec2 } from "../../src/core/types";
import type { ExperimentScenario } from "../protocol/schema";
import { constantVelocityTimeToContact, relativeGeometry } from "./geometry";
import type {
  PairwiseMetrics,
  PerAgentOutcomeMetrics,
  RunMethodMetadata,
  RunMetrics,
} from "./types";

export const PAIRWISE_AVOIDANCE_THRESHOLD_DEGREES = 5;

interface AgentAccumulator {
  initialPosition: Vec2;
  goal: Vec2;
  preferredSpeed: number;
  previousPosition: Vec2;
  previousVelocity: Vec2;
  previousAcceleration: Vec2 | null;
  pathLengthUntilArrival: number;
  firstArrivalTime: number | null;
}

export class RunMetricsAccumulator {
  private readonly scenario: ExperimentScenario;
  private readonly method: RunMethodMetadata;
  private readonly agents = new Map<number, AgentAccumulator>();
  private readonly pairwiseOnset = new Map<number, { time: number; ttc: number | null }>();
  private minimumPreCorrectionAgentClearance: number | null = null;
  private minimumPreCorrectionWallClearance: number | null = null;
  private minimumPairwisePreCenterDistance: number | null = null;
  private minimumPairwisePrePhysicalClearance: number | null = null;
  private minimumPairwisePostCenterDistance: number | null = null;
  private minimumPairwisePostPhysicalClearance: number | null = null;
  private preOverlapPairSeconds = 0;
  private postOverlapPairSeconds = 0;
  private maxPreAgentPenetration = 0;
  private maxPreWallPenetration = 0;
  private maxPostAgentPenetration = 0;
  private maxPostWallPenetration = 0;
  private totalIntended = 0;
  private totalAgentCorrection = 0;
  private totalWallCorrection = 0;
  private accelerationSquaredSum = 0;
  private jerkSquaredSum = 0;
  private accelerationSampleCount = 0;
  private jerkSampleCount = 0;
  private duration = 0;

  constructor(scenario: ExperimentScenario, method: RunMethodMetadata) {
    this.scenario = scenario;
    this.method = {
      ...method,
      methodParameters: { ...method.methodParameters },
    };
    for (const agent of scenario.agents) {
      this.agents.set(agent.id, {
        initialPosition: agent.position,
        goal: agent.goal,
        preferredSpeed: agent.preferredSpeed,
        previousPosition: agent.position,
        previousVelocity: agent.velocity,
        previousAcceleration: null,
        pathLengthUntilArrival: 0,
        firstArrivalTime: null,
      });
    }
  }

  observeStep(
    beforeStep: readonly AgentState[],
    diagnostic: StepDiagnostics,
    afterStep: readonly AgentState[],
  ): void {
    const dt = this.scenario.simulation.dt;
    this.duration = diagnostic.time;
    this.minimumPreCorrectionAgentClearance = minimumNullable(
      this.minimumPreCorrectionAgentClearance,
      diagnostic.minimumPreCorrectionAgentClearance,
    );
    this.minimumPreCorrectionWallClearance = minimumNullable(
      this.minimumPreCorrectionWallClearance,
      diagnostic.minimumPreCorrectionWallClearance,
    );
    this.preOverlapPairSeconds += diagnostic.preCorrectionOverlapPairs * dt;
    this.postOverlapPairSeconds += diagnostic.postCorrectionOverlapPairs * dt;
    this.maxPreAgentPenetration = Math.max(
      this.maxPreAgentPenetration,
      diagnostic.maximumPreCorrectionAgentPenetration,
    );
    this.maxPreWallPenetration = Math.max(
      this.maxPreWallPenetration,
      diagnostic.maximumPreCorrectionWallPenetration,
    );
    this.maxPostAgentPenetration = Math.max(
      this.maxPostAgentPenetration,
      diagnostic.maximumPostCorrectionAgentPenetration,
    );
    this.maxPostWallPenetration = Math.max(
      this.maxPostWallPenetration,
      diagnostic.maximumPostCorrectionWallPenetration,
    );
    this.totalIntended += diagnostic.intendedDisplacement;
    this.totalAgentCorrection += diagnostic.agentCorrectionDisplacement;
    this.totalWallCorrection += diagnostic.wallCorrectionDisplacement;

    const beforeById = new Map(beforeStep.map((agent) => [agent.id, agent]));
    const afterById = new Map(afterStep.map((agent) => [agent.id, agent]));
    for (const [id, accumulated] of this.agents) {
      const before = beforeById.get(id);
      const after = afterById.get(id);
      if (before === undefined || after === undefined) throw new Error(`Metrics missing agent ${id}`);
      const activeBeforeStep = accumulated.firstArrivalTime === null;
      if (activeBeforeStep) {
        accumulated.pathLengthUntilArrival += norm(sub(after.position, accumulated.previousPosition));
        const acceleration = scale(sub(after.velocity, accumulated.previousVelocity), 1 / dt);
        this.accelerationSquaredSum += dot(acceleration, acceleration);
        this.accelerationSampleCount += 1;
        if (accumulated.previousAcceleration !== null) {
          const jerk = scale(sub(acceleration, accumulated.previousAcceleration), 1 / dt);
          this.jerkSquaredSum += dot(jerk, jerk);
          this.jerkSampleCount += 1;
        }
        accumulated.previousAcceleration = acceleration;
        if (after.arrived) accumulated.firstArrivalTime = diagnostic.time;
      }
      accumulated.previousPosition = after.position;
      accumulated.previousVelocity = after.velocity;
    }

    if (this.scenario.family === "pairwise" && beforeStep.length === 2) {
      this.observePairwise(beforeStep, diagnostic);
    }
  }

  finish(finalStates: readonly AgentState[]): RunMetrics {
    const perAgent: PerAgentOutcomeMetrics[] = [...this.agents.entries()]
      .sort(([firstId], [secondId]) => firstId - secondId)
      .map(([id, accumulated]) => {
        const directDistance = norm(sub(accumulated.goal, accumulated.initialPosition));
        const idealTravelTime = directDistance / accumulated.preferredSpeed;
        return {
          id,
          firstArrivalTime: accumulated.firstArrivalTime,
          normalizedTravelTime:
            accumulated.firstArrivalTime === null || idealTravelTime <= 0
              ? null
              : accumulated.firstArrivalTime / idealTravelTime,
          pathEfficiency:
            accumulated.firstArrivalTime === null || directDistance <= 0
              ? null
              : accumulated.pathLengthUntilArrival / directDistance,
        };
      });
    const reached = perAgent.filter((agent) => agent.firstArrivalTime !== null).length;
    const normalizedTravelTimes = nonNull(perAgent.map((agent) => agent.normalizedTravelTime));
    const pathEfficiencies = nonNull(perAgent.map((agent) => agent.pathEfficiency));
    const finalArrived = finalStates.filter((agent) => agent.arrived).length;
    const totalCorrection = this.totalAgentCorrection + this.totalWallCorrection;
    const agentSeconds = this.scenario.agents.length * this.duration;
    return {
      identity: {
        scenarioName: this.scenario.name,
        family: this.scenario.family,
        variant: this.scenario.variant,
        split: this.scenario.split,
        seed: this.scenario.seed,
        methodId: this.method.methodId,
        methodKey: this.method.methodKey,
        methodConfigSha256: this.method.methodConfigSha256,
        velocityTimeConstant: this.method.velocityTimeConstant,
        methodParameters: { ...this.method.methodParameters },
        agentCount: this.scenario.agents.length,
        simulatedDuration: this.duration,
      },
      completion: {
        agentsReachedGoal: reached,
        successFraction: this.scenario.agents.length === 0 ? 0 : reached / this.scenario.agents.length,
        finalArrivedFraction:
          finalStates.length === 0 ? 0 : finalArrived / finalStates.length,
        perAgent,
      },
      travelTime: {
        meanNormalizedTravelTime: mean(normalizedTravelTimes),
        medianNormalizedTravelTime: median(normalizedTravelTimes),
      },
      pathEfficiency: {
        meanPathEfficiency: mean(pathEfficiencies),
        medianPathEfficiency: median(pathEfficiencies),
      },
      separation: {
        minimumPreCorrectionAgentClearance: this.minimumPreCorrectionAgentClearance,
        minimumPreCorrectionWallClearance: this.minimumPreCorrectionWallClearance,
        totalPreCorrectionOverlapPairSeconds: this.preOverlapPairSeconds,
        totalPostCorrectionOverlapPairSeconds: this.postOverlapPairSeconds,
        preCorrectionOverlapPairSecondsPerAgentSecond:
          agentSeconds === 0 ? null : this.preOverlapPairSeconds / agentSeconds,
        maximumPreCorrectionAgentPenetration: this.maxPreAgentPenetration,
        maximumPreCorrectionWallPenetration: this.maxPreWallPenetration,
        maximumPostCorrectionAgentPenetration: this.maxPostAgentPenetration,
        maximumPostCorrectionWallPenetration: this.maxPostWallPenetration,
      },
      correctionDependence: {
        totalIntendedDisplacement: this.totalIntended,
        totalAgentCorrectionDisplacement: this.totalAgentCorrection,
        totalWallCorrectionDisplacement: this.totalWallCorrection,
        totalCorrectionDisplacement: totalCorrection,
        correctionRatio:
          totalCorrection / (this.totalIntended + CORRECTION_RATIO_EPSILON_METERS),
      },
      smoothness: {
        rmsAcceleration:
          this.accelerationSampleCount === 0
            ? null
            : Math.sqrt(this.accelerationSquaredSum / this.accelerationSampleCount),
        rmsJerk:
          this.jerkSampleCount === 0 ? null : Math.sqrt(this.jerkSquaredSum / this.jerkSampleCount),
        accelerationSampleCount: this.accelerationSampleCount,
        jerkSampleCount: this.jerkSampleCount,
      },
      throughput: this.duration === 0 ? null : reached / this.duration,
      pairwise: this.finishPairwise(),
    };
  }

  private observePairwise(
    beforeStep: readonly AgentState[],
    diagnostic: StepDiagnostics,
  ): void {
    const orderedBefore = [...beforeStep].sort((a, b) => a.id - b.id);
    const [first, second] = orderedBefore;
    const diagnosticsById = new Map(diagnostic.perAgent.map((entry) => [entry.id, entry]));
    const firstDiagnostic = diagnosticsById.get(first.id);
    const secondDiagnostic = diagnosticsById.get(second.id);
    if (firstDiagnostic === undefined || secondDiagnostic === undefined) {
      throw new Error("Pairwise metrics are missing per-agent positions");
    }
    const preCenterDistance = norm(
      sub(firstDiagnostic.preCorrectionPosition, secondDiagnostic.preCorrectionPosition),
    );
    const postCenterDistance = norm(
      sub(firstDiagnostic.postCorrectionPosition, secondDiagnostic.postCorrectionPosition),
    );
    const combinedRadius = first.radius + second.radius;
    this.minimumPairwisePreCenterDistance = minimumNullable(
      this.minimumPairwisePreCenterDistance,
      preCenterDistance,
    );
    this.minimumPairwisePrePhysicalClearance = minimumNullable(
      this.minimumPairwisePrePhysicalClearance,
      preCenterDistance - combinedRadius,
    );
    this.minimumPairwisePostCenterDistance = minimumNullable(
      this.minimumPairwisePostCenterDistance,
      postCenterDistance,
    );
    this.minimumPairwisePostPhysicalClearance = minimumNullable(
      this.minimumPairwisePostPhysicalClearance,
      postCenterDistance - combinedRadius,
    );

    const targetById = new Map(diagnostic.perAgent.map((agent) => [agent.id, agent.targetVelocity]));
    for (const controlled of orderedBefore) {
      if (this.pairwiseOnset.has(controlled.id)) continue;
      const target = targetById.get(controlled.id);
      if (target === undefined) continue;
      const goalDirection = sub(controlled.goal, controlled.position);
      const targetSpeed = norm(target);
      const goalDistance = norm(goalDirection);
      if (targetSpeed === 0 || goalDistance === 0) continue;
      const cosine = Math.max(-1, Math.min(1, dot(target, goalDirection) / (targetSpeed * goalDistance)));
      const deflectionDegrees = (Math.acos(cosine) * 180) / Math.PI;
      if (deflectionDegrees <= PAIRWISE_AVOIDANCE_THRESHOLD_DEGREES) continue;
      const other = orderedBefore.find((agent) => agent.id !== controlled.id);
      if (other === undefined) continue;
      const relative = relativeGeometry(
        controlled.position,
        controlled.velocity,
        other.position,
        other.velocity,
      );
      this.pairwiseOnset.set(controlled.id, {
        time: Math.max(0, diagnostic.time - this.scenario.simulation.dt),
        ttc: constantVelocityTimeToContact(
          relative.relativePosition,
          relative.relativeVelocity,
          controlled.radius + other.radius,
        ),
      });
    }
  }

  private finishPairwise(): PairwiseMetrics | null {
    if (this.scenario.family !== "pairwise" || this.scenario.agents.length !== 2) return null;
    return {
      avoidanceThresholdDegrees: PAIRWISE_AVOIDANCE_THRESHOLD_DEGREES,
      perAgent: [...this.scenario.agents]
        .sort((a, b) => a.id - b.id)
        .map((agent) => ({
          id: agent.id,
          avoidanceOnsetTime: this.pairwiseOnset.get(agent.id)?.time ?? null,
          ttcAtAvoidanceOnset: this.pairwiseOnset.get(agent.id)?.ttc ?? null,
        })),
      minimumPreCorrectionCenterDistance: this.minimumPairwisePreCenterDistance,
      minimumPreCorrectionPhysicalClearance: this.minimumPairwisePrePhysicalClearance,
      minimumPostCorrectionCenterDistance: this.minimumPairwisePostCenterDistance,
      minimumPostCorrectionPhysicalClearance: this.minimumPairwisePostPhysicalClearance,
    };
  }
}

function minimumNullable(current: number | null, candidate: number | null): number | null {
  if (candidate === null) return current;
  return current === null ? candidate : Math.min(current, candidate);
}

function nonNull(values: readonly (number | null)[]): number[] {
  return values.filter((value): value is number => value !== null);
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
}
