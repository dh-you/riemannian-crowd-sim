import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { requireFiniteNumber, requireVec2 } from "../../src/core/validation";
import type { AgentState, Vec2 } from "../../src/core/types";
import { THIRD_PARTY_ROOT } from "../baselines/common/thirdParty";
import { requireSafeInteger, requireStrictObject } from "../protocol/validation";
import { forEachJsonLineSync } from "../protocol/jsonLines";
import type { ExperimentScenario } from "../protocol/schema";
import { resolveProtocolTarget } from "../protocol/completion";
import {
  ENGINE_STEP_VERSION,
  nativeStepDiagnostics,
  validateEngineStepRecord,
  type EngineAgentStep,
  type EngineStepRecord,
} from "./engineStep";

export const NATIVE_ENGINE_STEP_VERSION = 2 as const;
/** Scaled tolerance covering the pinned RVO2 adapter's float32 round-trip. */
export const NATIVE_POSITION_CONTINUITY_TOLERANCE_METERS = 2e-7;

interface NativeAgentStep {
  id: number;
  positionBefore: Vec2;
  velocityBefore: Vec2;
  proposedPosition: Vec2;
  navigationTarget: Vec2;
  commandVelocity: Vec2;
  realizedVelocity: Vec2;
  arrived: boolean;
}

interface NativeStepRecord {
  nativeEngineStepVersion: typeof NATIVE_ENGINE_STEP_VERSION;
  stepIndex: number;
  time: number;
  agents: NativeAgentStep[];
}

export interface ExternalInvocation {
  executable: string;
  arguments: string[];
  environment?: NodeJS.ProcessEnv;
  temporaryDirectory: string;
  outputPath: string;
}

export function runExternalProcess(invocation: ExternalInvocation): void {
  const result = spawnSync(invocation.executable, invocation.arguments, {
    cwd: invocation.temporaryDirectory,
    env: invocation.environment ?? process.env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    const stderr = `${result.stderr ?? ""}`;
    const logPath = resolve(invocation.temporaryDirectory, "stderr.log");
    writeFileSync(logPath, stderr, "utf8");
    const trimmed = stderr.trim();
    const excerpt = trimmed.length <= 2000
      ? trimmed
      : `${trimmed.slice(0, 500)}\n... stderr truncated ...\n${trimmed.slice(-1450)}`;
    throw new Error(
      `External engine exited ${String(result.status)}; stderr saved to ${logPath}: ${excerpt}`,
    );
  }
}

export function consumeNativeOutput(
  scenario: ExperimentScenario,
  outputPath: string,
  engineNamespace: string,
  sink: (record: EngineStepRecord) => void,
): AgentState[] {
  const expectedSteps = fixedStepCount(scenario);
  const orderedDefinitions = [...scenario.agents].sort((first, second) => first.id - second.id);
  const definitions = new Map(orderedDefinitions.map((agent) => [agent.id, agent]));
  const expectedIds = orderedDefinitions.map((agent) => agent.id);
  const expectedPositions = new Map(
    orderedDefinitions.map((agent) => [agent.id, agent.position] as const),
  );
  let finalStates = orderedDefinitions.map(cloneAgent);
  const emittedSteps = forEachJsonLineSync(outputPath, (line, index) => {
    if (index >= expectedSteps) {
      throw new Error(`External engine emitted more than ${expectedSteps} records`);
    }
    const native = parseNativeStep(JSON.parse(line) as unknown);
    if (native.stepIndex !== index) throw new Error(`External engine step out of order at ${index}`);
    const expectedTime = (index + 1) * scenario.simulation.dt;
    if (Math.abs(native.time - expectedTime) > 2e-6 * Math.max(1, expectedTime)) {
      throw new Error(`External engine time mismatch at step ${index}`);
    }
    if (native.agents.length !== scenario.agents.length) {
      throw new Error(`External engine agent count mismatch at step ${index}`);
    }
    const agents: EngineAgentStep[] = native.agents.map((agent, agentIndex) => {
      const expectedId = expectedIds[agentIndex];
      if (agent.id !== expectedId) {
        throw new Error(
          `External engine agent ID mismatch at step ${index}, index ${agentIndex}: expected ${expectedId}, received ${agent.id}`,
        );
      }
      const expectedPosition = expectedPositions.get(agent.id);
      if (expectedPosition === undefined) {
        throw new Error(`External engine emitted unknown agent ${agent.id}`);
      }
      assertPositionContinuity(agent.positionBefore, expectedPosition, agent.id, index);
      const definition = definitions.get(agent.id);
      if (definition === undefined) throw new Error(`Missing definition for agent ${agent.id}`);
      const expectedNavigationTarget = resolveProtocolTarget(scenario, {
        ...definition,
        position: agent.positionBefore,
      });
      assertNavigationTarget(agent.navigationTarget, expectedNavigationTarget, agent.id, index);
      return {
        id: agent.id,
        positionBefore: agent.positionBefore,
        velocityBefore: agent.velocityBefore,
        preCorrectionPosition: agent.proposedPosition,
        postCorrectionPosition: agent.proposedPosition,
        navigationTarget: agent.navigationTarget,
        commandVelocity: agent.commandVelocity,
        realizedVelocity: agent.realizedVelocity,
        arrived: agent.arrived,
      };
    });
    const record = validateEngineStepRecord({
      engineStepVersion: ENGINE_STEP_VERSION,
      stepIndex: native.stepIndex,
      time: expectedTime,
      agents,
      diagnostics: nativeStepDiagnostics(scenario.agents, scenario.walls, agents),
      engineMetadata: { [engineNamespace]: { nativeEngineStepVersion: NATIVE_ENGINE_STEP_VERSION } },
    });
    sink(record);
    finalStates = agents.map((agent) => {
      const definition = definitions.get(agent.id);
      if (definition === undefined) throw new Error(`Missing definition for agent ${agent.id}`);
      return {
        ...definition,
        position: agent.postCorrectionPosition,
        velocity: agent.realizedVelocity,
        arrived: agent.arrived,
      };
    });
    for (const agent of agents) expectedPositions.set(agent.id, agent.postCorrectionPosition);
  });
  if (emittedSteps !== expectedSteps) {
    throw new Error(`External engine emitted ${emittedSteps} records; expected ${expectedSteps}`);
  }
  return finalStates.sort((a, b) => a.id - b.id);
}

function parseNativeStep(value: unknown): NativeStepRecord {
  const root = requireStrictObject(value, "nativeStep", [
    "nativeEngineStepVersion",
    "stepIndex",
    "time",
    "agents",
  ]);
  if (root.nativeEngineStepVersion !== NATIVE_ENGINE_STEP_VERSION) {
    throw new Error(`Unsupported native engine step version: ${String(root.nativeEngineStepVersion)}`);
  }
  if (!Array.isArray(root.agents)) throw new Error("nativeStep.agents must be an array");
  const agents = root.agents.map((value_, index): NativeAgentStep => {
    const path = `nativeStep.agents[${index}]`;
    const agent = requireStrictObject(value_, path, [
      "id",
      "positionBefore",
      "velocityBefore",
      "proposedPosition",
      "navigationTarget",
      "commandVelocity",
      "realizedVelocity",
      "arrived",
    ]);
    if (typeof agent.arrived !== "boolean") throw new Error(`${path}.arrived must be boolean`);
    return {
      id: requireSafeInteger(agent.id, `${path}.id`),
      positionBefore: requireVec2(agent.positionBefore, `${path}.positionBefore`),
      velocityBefore: requireVec2(agent.velocityBefore, `${path}.velocityBefore`),
      proposedPosition: requireVec2(agent.proposedPosition, `${path}.proposedPosition`),
      navigationTarget: requireVec2(agent.navigationTarget, `${path}.navigationTarget`),
      commandVelocity: requireVec2(agent.commandVelocity, `${path}.commandVelocity`),
      realizedVelocity: requireVec2(agent.realizedVelocity, `${path}.realizedVelocity`),
      arrived: agent.arrived,
    };
  });
  let previousId: number | null = null;
  for (const agent of agents) {
    if (previousId !== null && agent.id <= previousId) {
      throw new Error("Native engine agents must be sorted by unique ascending ID");
    }
    previousId = agent.id;
  }
  return {
    nativeEngineStepVersion: NATIVE_ENGINE_STEP_VERSION,
    stepIndex: requireSafeInteger(root.stepIndex, "nativeStep.stepIndex"),
    time: requireFiniteNumber(root.time, "nativeStep.time"),
    agents,
  };
}

function assertNavigationTarget(
  actual: Vec2,
  expected: Vec2,
  agentId: number,
  stepIndex: number,
): void {
  const matches = actual.every((value, component) => {
    const expectedValue = expected[component];
    const scale = Math.max(1, Math.abs(value), Math.abs(expectedValue));
    return Math.abs(value - expectedValue) <= NATIVE_POSITION_CONTINUITY_TOLERANCE_METERS * scale;
  });
  if (!matches) {
    throw new Error(
      `External engine navigation target mismatch for agent ${agentId} at step ${stepIndex}`,
    );
  }
}

function assertPositionContinuity(
  actual: Vec2,
  expected: Vec2,
  agentId: number,
  stepIndex: number,
): void {
  const matches = actual.every((value, component) => {
    const expectedValue = expected[component];
    const scale = Math.max(1, Math.abs(value), Math.abs(expectedValue));
    return Math.abs(value - expectedValue) <= NATIVE_POSITION_CONTINUITY_TOLERANCE_METERS * scale;
  });
  if (!matches) {
    const context = stepIndex === 0 ? "initial position" : "position continuity";
    throw new Error(
      `External engine ${context} mismatch for agent ${agentId} at step ${stepIndex}: expected [${expected.join(", ")}], received [${actual.join(", ")}]`,
    );
  }
}

export function makeTemporaryDirectory(engineId: string, methodKey: string): string {
  const safeKey = methodKey.replaceAll(/[^a-z0-9_-]/giu, "_");
  const path = resolve(THIRD_PARTY_ROOT, "..", "tmp", `${engineId}-${process.pid}-${safeKey}`);
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  return path;
}

export function removeSuccessfulTemporaryDirectory(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export function fixedStepCount(scenario: ExperimentScenario): number {
  const ratio = scenario.simulation.horizonSeconds / scenario.simulation.dt;
  const steps = Math.round(ratio);
  if (Math.abs(ratio - steps) > 1e-9) throw new Error("Scenario horizon must be an integer multiple of dt");
  return steps;
}

function cloneAgent(agent: AgentState): AgentState {
  return { ...agent, position: [...agent.position], velocity: [...agent.velocity], goal: [...agent.goal] };
}
