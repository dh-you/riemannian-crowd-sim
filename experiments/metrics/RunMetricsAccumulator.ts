import { dot, norm, scale, sub } from "../../src/core/math";
import { CORRECTION_RATIO_EPSILON_METERS } from "../../src/core/SimulatorCore";
import type { AgentState, StepDiagnostics, Vec2 } from "../../src/core/types";
import {
  scientificDiagnosticToEngineStep,
  type EngineStepRecord,
} from "../engines/engineStep";
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
    for (const [id, accumulated] of this.agents) {
      const step = stepById.get(id);
      if (step === undefined) throw new Error(`Metrics missing agent ${id}`);
      if (accumulated.firstArrivalTime === null) {
        accumulated.pathLengthUntilArrival += norm(
          sub(step.postCorrectionPosition, accumulated.previousPosition),
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
        if (step.arrived) accumulated.firstArrivalTime = record.time;
      }
      accumulated.previousPosition = step.postCorrectionPosition;
      accumulated.previousVelocity = step.realizedVelocity;
    }

    if (this.scenario.family === "pairwise" && record.agents.length === 2) {
      this.observePairwise(record);
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
        agentsReachedGoal: reached,
        successFraction: this.scenario.agents.length === 0 ? 0 : reached / this.scenario.agents.length,
        finalArrivedFraction: finalStates.length === 0 ? 0 : finalArrived / finalStates.length,
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
      throughput: this.duration === 0 ? null : reached / this.duration,
      pairwise: this.finishPairwise(),
    };
  }

  private observePairwise(record: EngineStepRecord): void {
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
