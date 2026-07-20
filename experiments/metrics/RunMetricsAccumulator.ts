import { dot, norm, scale, sub } from "../../src/core/math";
import { CORRECTION_RATIO_EPSILON_METERS } from "../../src/core/SimulatorCore";
import type { AgentState, StepDiagnostics, Vec2 } from "../../src/core/types";
import {
  scientificDiagnosticToEngineStep,
  type EngineStepRecord,
} from "../engines/engineStep";
import type { ExperimentScenario } from "../protocol/schema";
import {
  completionRuleForAgent,
  detectCompletion,
  firstSegmentDiskIntersectionFraction,
  idealCompletionDistanceForAgent,
  minimumDistanceFromSegmentToPoint,
  pointIsNumericallyInGoalDisk,
} from "../protocol/completion";
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
  previousVelocity: Vec2;
  previousAcceleration: Vec2 | null;
  pathLengthUntilPointGoalArrival: number;
  firstCompletionTime: number | null;
  legacyFirstPointGoalArrivalTime: number | null;
  minimumDistanceToPointGoal: number;
  finalDistanceToPointGoal: number;
}

export class RunMetricsAccumulator {
  private readonly scenario: ExperimentScenario;
  private readonly method: Required<Omit<RunMethodMetadata, "upstreamProject" | "upstreamCommit" | "upstreamLicense">> &
    Pick<RunMethodMetadata, "upstreamProject" | "upstreamCommit" | "upstreamLicense">;
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
  private preCorrectionGoalDiskEntries = 0;
  private postCorrectionGoalDiskEntries = 0;
  private correctionEjectedGoalDiskEntries = 0;

  constructor(scenario: ExperimentScenario, method: RunMethodMetadata) {
    this.scenario = scenario;
    this.method = {
      ...method,
      methodIdentityVersion: method.methodIdentityVersion ?? 1,
      methodConfigCanonicalSha256:
        method.methodConfigCanonicalSha256 ?? method.methodConfigSha256,
      methodConfigSourceSha256: method.methodConfigSourceSha256 ?? method.methodConfigSha256,
      engineId: method.engineId ?? "scientific_core_engine_v1",
      engineAdapterVersion: method.engineAdapterVersion ?? "stage-b-compatibility",
      correctionMode: method.correctionMode ?? "shared_projection",
      commandVelocityMeaning:
        method.commandVelocityMeaning ?? "controller target velocity before Scientific Core smoothing",
      upstreamProject: method.upstreamProject ?? null,
      upstreamCommit: method.upstreamCommit ?? null,
      upstreamLicense: method.upstreamLicense ?? null,
      methodParameters: { ...method.methodParameters },
    };
    for (const agent of scenario.agents) {
      const initialPointGoalDistance = norm(sub(agent.position, agent.goal));
      const startsInPointGoal = initialPointGoalDistance <= scenario.simulation.goalTolerance;
      const completionRule = completionRuleForAgent(scenario, agent.id);
      this.agents.set(agent.id, {
        initialPosition: agent.position,
        goal: agent.goal,
        preferredSpeed: agent.preferredSpeed,
        previousVelocity: agent.velocity,
        previousAcceleration: null,
        pathLengthUntilPointGoalArrival: 0,
        firstCompletionTime: completionRule.type === "goal_disk" && startsInPointGoal ? 0 : null,
        legacyFirstPointGoalArrivalTime: startsInPointGoal ? 0 : null,
        minimumDistanceToPointGoal: initialPointGoalDistance,
        finalDistanceToPointGoal: initialPointGoalDistance,
      });
    }
  }

  observeStep(record: EngineStepRecord): void;
  /** @deprecated Stage B compatibility overload. */
  observeStep(
    beforeStep: readonly AgentState[],
    diagnostic: StepDiagnostics,
    afterStep: readonly AgentState[],
  ): void;
  observeStep(
    recordOrBefore: EngineStepRecord | readonly AgentState[],
    diagnostic?: StepDiagnostics,
    afterStep?: readonly AgentState[],
  ): void {
    const record = Array.isArray(recordOrBefore)
      ? scientificDiagnosticToEngineStep(
          recordOrBefore,
          requireDefined(diagnostic, "diagnostic"),
          requireDefined(afterStep, "afterStep"),
          this.scenario.simulation.correction.enabled ? "shared_projection" : "disabled",
        )
      : (recordOrBefore as EngineStepRecord);
    this.observeEngineStep(record);
  }

  private observeEngineStep(record: EngineStepRecord): void {
    const dt = this.scenario.simulation.dt;
    this.duration = record.time;
    const diagnostics = record.diagnostics;
    this.minimumPreCorrectionAgentClearance = minimumNullable(
      this.minimumPreCorrectionAgentClearance,
      diagnostics.minimumPreCorrectionAgentClearance,
    );
    this.minimumPreCorrectionWallClearance = minimumNullable(
      this.minimumPreCorrectionWallClearance,
      diagnostics.minimumPreCorrectionWallClearance,
    );
    this.preOverlapPairSeconds += diagnostics.preCorrectionOverlapPairs * dt;
    this.postOverlapPairSeconds += diagnostics.postCorrectionOverlapPairs * dt;
    this.maxPreAgentPenetration = Math.max(
      this.maxPreAgentPenetration,
      diagnostics.maximumPreCorrectionAgentPenetration,
    );
    this.maxPreWallPenetration = Math.max(
      this.maxPreWallPenetration,
      diagnostics.maximumPreCorrectionWallPenetration,
    );
    this.maxPostAgentPenetration = Math.max(
      this.maxPostAgentPenetration,
      diagnostics.maximumPostCorrectionAgentPenetration,
    );
    this.maxPostWallPenetration = Math.max(
      this.maxPostWallPenetration,
      diagnostics.maximumPostCorrectionWallPenetration,
    );
    this.totalIntended += diagnostics.intendedDisplacement;
    this.totalAgentCorrection += diagnostics.agentCorrectionDisplacement;
    this.totalWallCorrection += diagnostics.wallCorrectionDisplacement;

    const stepById = new Map(record.agents.map((agent) => [agent.id, agent]));
    const pointGoalArrivedBeforeStep = new Set<number>();
    for (const [id, accumulated] of this.agents) {
      const step = stepById.get(id);
      if (step === undefined) throw new Error(`Metrics missing agent ${id}`);
      const definition = this.scenario.agents.find((agent) => agent.id === id);
      if (definition === undefined) throw new Error(`Scenario missing agent ${id}`);
      if (accumulated.legacyFirstPointGoalArrivalTime !== null) {
        pointGoalArrivedBeforeStep.add(id);
      }
      if (accumulated.legacyFirstPointGoalArrivalTime === null) {
        accumulated.pathLengthUntilPointGoalArrival += norm(
          sub(step.postCorrectionPosition, step.positionBefore),
        );
        const acceleration = scale(sub(step.realizedVelocity, accumulated.previousVelocity), 1 / dt);
        this.accelerationSquaredSum += dot(acceleration, acceleration);
        this.accelerationSampleCount += 1;
        if (accumulated.previousAcceleration !== null) {
          const jerk = scale(sub(acceleration, accumulated.previousAcceleration), 1 / dt);
          this.jerkSquaredSum += dot(jerk, jerk);
          this.jerkSampleCount += 1;
        }
        accumulated.previousAcceleration = acceleration;
      }
      const stepStartTime = record.time - dt;
      const startsOutsideGoalDisk = !pointIsNumericallyInGoalDisk(
        step.positionBefore,
        definition.goal,
        this.scenario.simulation.goalTolerance,
      );
      const preGoalFraction = firstSegmentDiskIntersectionFraction(
        step.positionBefore,
        step.preCorrectionPosition,
        definition.goal,
        this.scenario.simulation.goalTolerance,
      );
      const postGoalFraction = firstSegmentDiskIntersectionFraction(
        step.positionBefore,
        step.postCorrectionPosition,
        definition.goal,
        this.scenario.simulation.goalTolerance,
      );
      if (startsOutsideGoalDisk && preGoalFraction !== null) this.preCorrectionGoalDiskEntries += 1;
      if (startsOutsideGoalDisk && postGoalFraction !== null) this.postCorrectionGoalDiskEntries += 1;
      if (
        norm(sub(step.preCorrectionPosition, definition.goal))
          <= this.scenario.simulation.goalTolerance
        && norm(sub(step.postCorrectionPosition, definition.goal))
          > this.scenario.simulation.goalTolerance
      ) {
        this.correctionEjectedGoalDiskEntries += 1;
      }
      if (accumulated.legacyFirstPointGoalArrivalTime === null && postGoalFraction !== null) {
        accumulated.legacyFirstPointGoalArrivalTime = stepStartTime + postGoalFraction * dt;
      }
      if (accumulated.firstCompletionTime === null) {
        const completion = detectCompletion(
          this.scenario,
          definition,
          step.positionBefore,
          step.postCorrectionPosition,
        );
        if (completion !== null) {
          accumulated.firstCompletionTime = stepStartTime + completion.segmentFraction * dt;
        }
      }
      accumulated.minimumDistanceToPointGoal = Math.min(
        accumulated.minimumDistanceToPointGoal,
        minimumDistanceFromSegmentToPoint(
          step.positionBefore,
          step.postCorrectionPosition,
          definition.goal,
        ),
      );
      accumulated.finalDistanceToPointGoal = norm(sub(step.postCorrectionPosition, definition.goal));
      accumulated.previousVelocity = step.realizedVelocity;
    }

    if (this.scenario.family === "pairwise" && record.agents.length === 2) {
      this.observePairwise(record, pointGoalArrivedBeforeStep);
    }
  }

  finish(finalStates: readonly AgentState[]): RunMetrics {
    const finalById = new Map(finalStates.map((agent) => [agent.id, agent]));
    const perAgent: PerAgentOutcomeMetrics[] = [...this.agents.entries()]
      .sort(([firstId], [secondId]) => firstId - secondId)
      .map(([id, accumulated]) => {
        const directDistance = norm(sub(accumulated.goal, accumulated.initialPosition));
        const idealCompletionDistance = idealCompletionDistanceForAgent(this.scenario, id);
        const idealCompletionTime = idealCompletionDistance / accumulated.preferredSpeed;
        const finalState = finalById.get(id);
        if (finalState === undefined) throw new Error(`Final states missing agent ${id}`);
        const completionRule = completionRuleForAgent(this.scenario, id);
        return {
          id,
          completionType: completionRule.type,
          idealCompletionDistance,
          firstCompletionTime: accumulated.firstCompletionTime,
          normalizedCompletionTime:
            accumulated.firstCompletionTime === null || idealCompletionTime <= 0
              ? null
              : accumulated.firstCompletionTime / idealCompletionTime,
          legacyFirstPointGoalArrivalTime: accumulated.legacyFirstPointGoalArrivalTime,
          minimumDistanceToPointGoal: accumulated.minimumDistanceToPointGoal,
          finalDistanceToPointGoal: norm(sub(finalState.position, accumulated.goal)),
          pathEfficiency:
            accumulated.legacyFirstPointGoalArrivalTime === null || directDistance <= 0
              ? null
              : accumulated.pathLengthUntilPointGoalArrival / directDistance,
        };
      });
    const completed = perAgent.filter((agent) => agent.firstCompletionTime !== null).length;
    const legacyCompleted = perAgent.filter(
      (agent) => agent.legacyFirstPointGoalArrivalTime !== null,
    ).length;
    const normalizedCompletionTimes = nonNull(
      perAgent.map((agent) => agent.normalizedCompletionTime),
    );
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
        methodIdentityVersion: this.method.methodIdentityVersion,
        methodConfigCanonicalSha256: this.method.methodConfigCanonicalSha256,
        methodConfigSourceSha256: this.method.methodConfigSourceSha256,
        methodConfigSha256: this.method.methodConfigCanonicalSha256,
        engineId: this.method.engineId,
        engineAdapterVersion: this.method.engineAdapterVersion,
        correctionMode: this.method.correctionMode,
        commandVelocityMeaning: this.method.commandVelocityMeaning,
        upstreamProject: this.method.upstreamProject ?? null,
        upstreamCommit: this.method.upstreamCommit ?? null,
        upstreamLicense: this.method.upstreamLicense ?? null,
        velocityTimeConstant: this.method.velocityTimeConstant,
        methodParameters: { ...this.method.methodParameters },
        agentCount: this.scenario.agents.length,
        simulatedDuration: this.duration,
      },
      completion: {
        completionRuleType: this.scenario.completion.rule.type,
        completedAgents: completed,
        successFraction: this.scenario.agents.length === 0 ? 0 : completed / this.scenario.agents.length,
        legacyPointGoalCompletedAgents: legacyCompleted,
        legacyPointGoalSuccessFraction:
          this.scenario.agents.length === 0 ? 0 : legacyCompleted / this.scenario.agents.length,
        legacyFinalPointGoalArrivedFraction:
          finalStates.length === 0 ? 0 : finalArrived / finalStates.length,
        preCorrectionGoalDiskEntries: this.preCorrectionGoalDiskEntries,
        postCorrectionGoalDiskEntries: this.postCorrectionGoalDiskEntries,
        correctionEjectedGoalDiskEntries: this.correctionEjectedGoalDiskEntries,
        perAgent,
      },
      completionTime: {
        meanNormalizedCompletionTime: mean(normalizedCompletionTimes),
        medianNormalizedCompletionTime: median(normalizedCompletionTimes),
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
        correctionRatio: totalCorrection / (this.totalIntended + CORRECTION_RATIO_EPSILON_METERS),
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
      throughput: this.duration === 0 ? null : completed / this.duration,
      pairwise: this.finishPairwise(),
    };
  }

  private observePairwise(record: EngineStepRecord, arrivedBeforeStep: ReadonlySet<number>): void {
    const ordered = [...record.agents].sort((first, second) => first.id - second.id);
    const [first, second] = ordered;
    const preCenterDistance = norm(sub(first.preCorrectionPosition, second.preCorrectionPosition));
    const postCenterDistance = norm(sub(first.postCorrectionPosition, second.postCorrectionPosition));
    const radii = new Map(this.scenario.agents.map((agent) => [agent.id, agent.radius]));
    const combinedRadius = requireNumber(radii.get(first.id)) + requireNumber(radii.get(second.id));
    this.minimumPairwisePreCenterDistance = minimumNullable(this.minimumPairwisePreCenterDistance, preCenterDistance);
    this.minimumPairwisePrePhysicalClearance = minimumNullable(this.minimumPairwisePrePhysicalClearance, preCenterDistance - combinedRadius);
    this.minimumPairwisePostCenterDistance = minimumNullable(this.minimumPairwisePostCenterDistance, postCenterDistance);
    this.minimumPairwisePostPhysicalClearance = minimumNullable(this.minimumPairwisePostPhysicalClearance, postCenterDistance - combinedRadius);

    const scenarioById = new Map(this.scenario.agents.map((agent) => [agent.id, agent]));
    for (const controlled of ordered) {
      if (arrivedBeforeStep.has(controlled.id)) continue;
      if (this.pairwiseOnset.has(controlled.id)) continue;
      const definition = scenarioById.get(controlled.id);
      if (definition === undefined) throw new Error(`Pairwise scenario missing agent ${controlled.id}`);
      const goalDirection = sub(definition.goal, controlled.positionBefore);
      const targetSpeed = norm(controlled.commandVelocity);
      const goalDistance = norm(goalDirection);
      if (targetSpeed === 0 || goalDistance === 0) continue;
      const cosine = Math.max(-1, Math.min(1, dot(controlled.commandVelocity, goalDirection) / (targetSpeed * goalDistance)));
      const deflectionDegrees = (Math.acos(cosine) * 180) / Math.PI;
      if (deflectionDegrees <= PAIRWISE_AVOIDANCE_THRESHOLD_DEGREES) continue;
      const other = ordered.find((agent) => agent.id !== controlled.id);
      if (other === undefined) continue;
      const otherDefinition = scenarioById.get(other.id);
      if (otherDefinition === undefined) throw new Error(`Pairwise scenario missing agent ${other.id}`);
      const relative = relativeGeometry(
        controlled.positionBefore,
        controlled.velocityBefore,
        other.positionBefore,
        other.velocityBefore,
      );
      this.pairwiseOnset.set(controlled.id, {
        time: Math.max(0, record.time - this.scenario.simulation.dt),
        ttc: constantVelocityTimeToContact(
          relative.relativePosition,
          relative.relativeVelocity,
          definition.radius + otherDefinition.radius,
        ),
      });
    }
  }

  private finishPairwise(): PairwiseMetrics | null {
    if (this.scenario.family !== "pairwise" || this.scenario.agents.length !== 2) return null;
    return {
      avoidanceThresholdDegrees: PAIRWISE_AVOIDANCE_THRESHOLD_DEGREES,
      perAgent: [...this.scenario.agents].sort((a, b) => a.id - b.id).map((agent) => ({
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

function requireDefined<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`Missing ${name}`);
  return value;
}

function requireNumber(value: number | undefined): number {
  if (value === undefined) throw new Error("Missing pairwise radius");
  return value;
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
