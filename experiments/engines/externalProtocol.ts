import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { requireFiniteNumber, requireVec2 } from "../../src/core/validation";
import type { AgentState, Vec2 } from "../../src/core/types";
import { THIRD_PARTY_ROOT } from "../baselines/common/thirdParty";
import { requireSafeInteger, requireStrictObject } from "../protocol/validation";
import type { ExperimentScenario } from "../protocol/schema";
import {
  ENGINE_STEP_VERSION,
  nativeStepDiagnostics,
  validateEngineStepRecord,
  type EngineAgentStep,
  type EngineStepRecord,
} from "./engineStep";

export const NATIVE_ENGINE_STEP_VERSION = 1 as const;

interface NativeAgentStep {
  id: number;
  positionBefore: Vec2;
  velocityBefore: Vec2;
  proposedPosition: Vec2;
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
  const lines = readFileSync(outputPath, "utf8").split(/\r?\n/u).filter(Boolean);
  const expectedSteps = fixedStepCount(scenario);
  if (lines.length !== expectedSteps) {
    throw new Error(`External engine emitted ${lines.length} records; expected ${expectedSteps}`);
  }
  const definitions = new Map(scenario.agents.map((agent) => [agent.id, agent]));
  let finalStates = scenario.agents.map(cloneAgent);
  for (const [index, line] of lines.entries()) {
    const native = parseNativeStep(JSON.parse(line) as unknown);
    if (native.stepIndex !== index) throw new Error(`External engine step out of order at ${index}`);
    const expectedTime = (index + 1) * scenario.simulation.dt;
    if (Math.abs(native.time - expectedTime) > 2e-6 * Math.max(1, expectedTime)) {
      throw new Error(`External engine time mismatch at step ${index}`);
    }
    if (native.agents.length !== scenario.agents.length) {
      throw new Error(`External engine agent count mismatch at step ${index}`);
    }
    const agents: EngineAgentStep[] = native.agents.map((agent) => {
      if (!definitions.has(agent.id)) throw new Error(`External engine emitted unknown agent ${agent.id}`);
      return {
        id: agent.id,
        positionBefore: agent.positionBefore,
        velocityBefore: agent.velocityBefore,
        preCorrectionPosition: agent.proposedPosition,
        postCorrectionPosition: agent.proposedPosition,
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
      engineMetadata: { [engineNamespace]: { nativeEngineStepVersion: 1 } },
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
      commandVelocity: requireVec2(agent.commandVelocity, `${path}.commandVelocity`),
      realizedVelocity: requireVec2(agent.realizedVelocity, `${path}.realizedVelocity`),
      arrived: agent.arrived,
    };
  }).sort((a, b) => a.id - b.id);
  const ids = new Set(agents.map((agent) => agent.id));
  if (ids.size !== agents.length) throw new Error("Native engine step contains duplicate agent IDs");
  return {
    nativeEngineStepVersion: NATIVE_ENGINE_STEP_VERSION,
    stepIndex: requireSafeInteger(root.stepIndex, "nativeStep.stepIndex"),
    time: requireFiniteNumber(root.time, "nativeStep.time"),
    agents,
  };
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
