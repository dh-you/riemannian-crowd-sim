import { measureContacts } from "../../src/core/diagnostics";
import { isFiniteVec2, norm, sub } from "../../src/core/math";
import type { AgentState, StepDiagnostics, Vec2, WallSegment } from "../../src/core/types";

export const ENGINE_STEP_VERSION = 1 as const;

export type CorrectionMode = "shared_projection" | "disabled" | "native_none";

export interface EngineAgentStep {
  id: number;
  positionBefore: Vec2;
  velocityBefore: Vec2;
  preCorrectionPosition: Vec2;
  postCorrectionPosition: Vec2;
  commandVelocity: Vec2;
  realizedVelocity: Vec2;
  arrived: boolean;
}

export interface EngineStepDiagnostics {
  preCorrectionOverlapPairs: number;
  postCorrectionOverlapPairs: number;
  preCorrectionWallContacts: number;
  postCorrectionWallContacts: number;
  minimumPreCorrectionAgentClearance: number | null;
  minimumPreCorrectionWallClearance: number | null;
  maximumPreCorrectionAgentPenetration: number;
  maximumPostCorrectionAgentPenetration: number;
  maximumPreCorrectionWallPenetration: number;
  maximumPostCorrectionWallPenetration: number;
  totalPreCorrectionAgentPenetration: number;
  totalPostCorrectionAgentPenetration: number;
  totalPreCorrectionWallPenetration: number;
  totalPostCorrectionWallPenetration: number;
  intendedDisplacement: number;
  agentCorrectionDisplacement: number;
  wallCorrectionDisplacement: number;
  totalCorrectionDisplacement: number;
  correctionMode: CorrectionMode;
}

export interface EngineStepRecord {
  engineStepVersion: typeof ENGINE_STEP_VERSION;
  stepIndex: number;
  time: number;
  agents: EngineAgentStep[];
  diagnostics: EngineStepDiagnostics;
  engineMetadata?: Record<string, unknown>;
}

export function scientificDiagnosticToEngineStep(
  beforeStep: readonly AgentState[],
  diagnostic: StepDiagnostics,
  afterStep: readonly AgentState[],
  correctionMode: CorrectionMode,
): EngineStepRecord {
  const after = new Map(afterStep.map((agent) => [agent.id, agent]));
  const perAgent = new Map(diagnostic.perAgent.map((agent) => [agent.id, agent]));
  return validateEngineStepRecord({
    engineStepVersion: ENGINE_STEP_VERSION,
    stepIndex: diagnostic.stepIndex,
    time: diagnostic.time,
    agents: [...beforeStep]
      .sort((first, second) => first.id - second.id)
      .map((agent): EngineAgentStep => {
        const completed = after.get(agent.id);
        const step = perAgent.get(agent.id);
        if (completed === undefined || step === undefined) {
          throw new Error(`Scientific Core step is missing agent ${agent.id}`);
        }
        return {
          id: agent.id,
          positionBefore: agent.position,
          velocityBefore: agent.velocity,
          preCorrectionPosition: step.preCorrectionPosition,
          postCorrectionPosition: step.postCorrectionPosition,
          commandVelocity: step.targetVelocity,
          realizedVelocity: step.realizedVelocity,
          arrived: completed.arrived,
        };
      }),
    diagnostics: {
      preCorrectionOverlapPairs: diagnostic.preCorrectionOverlapPairs,
      postCorrectionOverlapPairs: diagnostic.postCorrectionOverlapPairs,
      preCorrectionWallContacts: diagnostic.preCorrectionWallContacts,
      postCorrectionWallContacts: diagnostic.postCorrectionWallContacts,
      minimumPreCorrectionAgentClearance: diagnostic.minimumPreCorrectionAgentClearance,
      minimumPreCorrectionWallClearance: diagnostic.minimumPreCorrectionWallClearance,
      maximumPreCorrectionAgentPenetration:
        diagnostic.maximumPreCorrectionAgentPenetration,
      maximumPostCorrectionAgentPenetration:
        diagnostic.maximumPostCorrectionAgentPenetration,
      maximumPreCorrectionWallPenetration:
        diagnostic.maximumPreCorrectionWallPenetration,
      maximumPostCorrectionWallPenetration:
        diagnostic.maximumPostCorrectionWallPenetration,
      totalPreCorrectionAgentPenetration:
        diagnostic.totalPreCorrectionOverlapPenetration,
      totalPostCorrectionAgentPenetration:
        diagnostic.totalPostCorrectionOverlapPenetration,
      totalPreCorrectionWallPenetration: diagnostic.totalPreCorrectionWallPenetration,
      totalPostCorrectionWallPenetration: diagnostic.totalPostCorrectionWallPenetration,
      intendedDisplacement: diagnostic.intendedDisplacement,
      agentCorrectionDisplacement: diagnostic.agentCorrectionDisplacement,
      wallCorrectionDisplacement: diagnostic.wallCorrectionDisplacement,
      totalCorrectionDisplacement: diagnostic.totalCorrectionDisplacement,
      correctionMode,
    },
    engineMetadata: {
      scientificCore: {
        coincidentNeighborContributionsSkipped:
          diagnostic.coincidentNeighborContributionsSkipped,
      },
    },
  });
}

/** Builds native-none diagnostics from native positions without hiding contacts. */
export function nativeStepDiagnostics(
  agents: readonly AgentState[],
  walls: readonly WallSegment[],
  stepAgents: readonly EngineAgentStep[],
): EngineStepDiagnostics {
  const pre = new Map(stepAgents.map((agent) => [agent.id, agent.preCorrectionPosition]));
  const post = new Map(stepAgents.map((agent) => [agent.id, agent.postCorrectionPosition]));
  const preContacts = measureContacts(agents, walls, pre);
  const postContacts = measureContacts(agents, walls, post);
  const intendedDisplacement = stepAgents.reduce(
    (sum, agent) => sum + norm(sub(agent.preCorrectionPosition, agent.positionBefore)),
    0,
  );
  return {
    preCorrectionOverlapPairs: preContacts.overlapPairs,
    postCorrectionOverlapPairs: postContacts.overlapPairs,
    preCorrectionWallContacts: preContacts.wallContacts,
    postCorrectionWallContacts: postContacts.wallContacts,
    minimumPreCorrectionAgentClearance: preContacts.minimumAgentClearance,
    minimumPreCorrectionWallClearance: preContacts.minimumWallClearance,
    maximumPreCorrectionAgentPenetration: preContacts.maxAgentPenetration,
    maximumPostCorrectionAgentPenetration: postContacts.maxAgentPenetration,
    maximumPreCorrectionWallPenetration: preContacts.maxWallPenetration,
    maximumPostCorrectionWallPenetration: postContacts.maxWallPenetration,
    totalPreCorrectionAgentPenetration: preContacts.totalAgentPenetration,
    totalPostCorrectionAgentPenetration: postContacts.totalAgentPenetration,
    totalPreCorrectionWallPenetration: preContacts.totalWallPenetration,
    totalPostCorrectionWallPenetration: postContacts.totalWallPenetration,
    intendedDisplacement,
    agentCorrectionDisplacement: 0,
    wallCorrectionDisplacement: 0,
    totalCorrectionDisplacement: 0,
    correctionMode: "native_none",
  };
}

export function validateEngineStepRecord(value: EngineStepRecord): EngineStepRecord {
  assertExactKeys(value, [
    "engineStepVersion",
    "stepIndex",
    "time",
    "agents",
    "diagnostics",
    "engineMetadata",
  ], "engineStep");
  if (value.engineStepVersion !== ENGINE_STEP_VERSION) {
    throw new Error(`Unsupported engineStepVersion: ${String(value.engineStepVersion)}`);
  }
  finiteNonnegativeInteger(value.stepIndex, "engineStep.stepIndex");
  finiteNonnegative(value.time, "engineStep.time");
  if (!Array.isArray(value.agents)) throw new Error("engineStep.agents must be an array");
  let previousId: number | null = null;
  for (const [index, agent] of value.agents.entries()) {
    assertExactKeys(agent, [
      "id",
      "positionBefore",
      "velocityBefore",
      "preCorrectionPosition",
      "postCorrectionPosition",
      "commandVelocity",
      "realizedVelocity",
      "arrived",
    ], `engineStep.agents[${index}]`);
    finiteSafeInteger(agent.id, `engineStep.agents[${index}].id`);
    if (previousId !== null && agent.id <= previousId) {
      throw new Error("engineStep agents must be sorted by unique ascending ID");
    }
    previousId = agent.id;
    for (const [key, vector] of Object.entries({
      positionBefore: agent.positionBefore,
      velocityBefore: agent.velocityBefore,
      preCorrectionPosition: agent.preCorrectionPosition,
      postCorrectionPosition: agent.postCorrectionPosition,
      commandVelocity: agent.commandVelocity,
      realizedVelocity: agent.realizedVelocity,
    })) {
      if (!isFiniteVec2(vector)) throw new Error(`engineStep.agents[${index}].${key} must be finite`);
    }
    if (typeof agent.arrived !== "boolean") {
      throw new Error(`engineStep.agents[${index}].arrived must be boolean`);
    }
  }
  const diagnostics = value.diagnostics;
  assertExactKeys(diagnostics, [
    "preCorrectionOverlapPairs",
    "postCorrectionOverlapPairs",
    "preCorrectionWallContacts",
    "postCorrectionWallContacts",
    "minimumPreCorrectionAgentClearance",
    "minimumPreCorrectionWallClearance",
    "maximumPreCorrectionAgentPenetration",
    "maximumPostCorrectionAgentPenetration",
    "maximumPreCorrectionWallPenetration",
    "maximumPostCorrectionWallPenetration",
    "totalPreCorrectionAgentPenetration",
    "totalPostCorrectionAgentPenetration",
    "totalPreCorrectionWallPenetration",
    "totalPostCorrectionWallPenetration",
    "intendedDisplacement",
    "agentCorrectionDisplacement",
    "wallCorrectionDisplacement",
    "totalCorrectionDisplacement",
    "correctionMode",
  ], "engineStep.diagnostics");
  const counts = [
    "preCorrectionOverlapPairs",
    "postCorrectionOverlapPairs",
    "preCorrectionWallContacts",
    "postCorrectionWallContacts",
  ] as const;
  for (const key of counts) finiteNonnegativeInteger(diagnostics[key], `engineStep.diagnostics.${key}`);
  const optional = [
    "minimumPreCorrectionAgentClearance",
    "minimumPreCorrectionWallClearance",
  ] as const;
  for (const key of optional) {
    if (diagnostics[key] !== null) finite(diagnostics[key], `engineStep.diagnostics.${key}`);
  }
  const nonnegative = [
    "maximumPreCorrectionAgentPenetration",
    "maximumPostCorrectionAgentPenetration",
    "maximumPreCorrectionWallPenetration",
    "maximumPostCorrectionWallPenetration",
    "totalPreCorrectionAgentPenetration",
    "totalPostCorrectionAgentPenetration",
    "totalPreCorrectionWallPenetration",
    "totalPostCorrectionWallPenetration",
    "intendedDisplacement",
    "agentCorrectionDisplacement",
    "wallCorrectionDisplacement",
    "totalCorrectionDisplacement",
  ] as const;
  for (const key of nonnegative) finiteNonnegative(diagnostics[key], `engineStep.diagnostics.${key}`);
  if (!["shared_projection", "disabled", "native_none"].includes(diagnostics.correctionMode)) {
    throw new Error(`Unsupported correction mode: ${diagnostics.correctionMode}`);
  }
  assertNoNonFinite(value.engineMetadata, "engineStep.engineMetadata");
  return value;
}

function assertExactKeys(value: unknown, allowed: readonly string[], path: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new Error(`${path}.${key} is not allowed`);
  }
  for (const key of allowed) {
    if (key !== "engineMetadata" && !Object.hasOwn(value, key)) {
      throw new Error(`${path}.${key} is required`);
    }
  }
}

export function serializeEngineStep(record: EngineStepRecord): string {
  validateEngineStepRecord(record);
  return `${JSON.stringify(record)}\n`;
}

function finite(value: number, path: string): void {
  if (!Number.isFinite(value)) throw new Error(`${path} must be finite`);
}

function finiteNonnegative(value: number, path: string): void {
  finite(value, path);
  if (value < 0) throw new Error(`${path} must be nonnegative`);
}

function finiteSafeInteger(value: number, path: string): void {
  if (!Number.isSafeInteger(value)) throw new Error(`${path} must be a safe integer`);
}

function finiteNonnegativeInteger(value: number, path: string): void {
  finiteSafeInteger(value, path);
  if (value < 0) throw new Error(`${path} must be nonnegative`);
}

function assertNoNonFinite(value: unknown, path: string): void {
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`${path} is non-finite`);
  if (Array.isArray(value)) value.forEach((entry, index) => assertNoNonFinite(entry, `${path}[${index}]`));
  else if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) assertNoNonFinite(entry, `${path}.${key}`);
  }
}
