import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createJuPedSimGeometry } from "../baselines/jupedsim/geometry";
import { protocolNavigationRunnerConfig } from "../protocol/completion";
import type { MethodIdentity } from "../protocol/methodIdentity";
import {
  JUPEDSIM_SFM_ENGINE_ID,
  JUPEDSIM_SFM_METHOD_ID,
  type JuPedSimSfmMethodConfig,
  type MethodConfig,
} from "../protocol/methodConfig";
import type { ExperimentScenario } from "../protocol/schema";
import { jupedSimProvenance, baselineRuntimePaths } from "./baselineProvenance";
import type { EngineRunResult, EngineStepSink, ExperimentEngine } from "./ExperimentEngine";
import {
  consumeNativeOutput,
  fixedStepCount,
  makeTemporaryDirectory,
  removeSuccessfulTemporaryDirectory,
  runExternalProcess,
} from "./externalProtocol";

interface JuPedSimRunnerMetadata {
  runnerMetadataVersion: 2;
  jupedsimVersion: string;
  pythonVersion: string;
  geometrySha256: string;
  finalGeometrySha256: string;
  experimentDt: number;
  nativeJuPedSimDt: number;
  nativeSubstepsPerExperimentStep: number;
  nativeIterationCount: number;
  protocolTargetResolutionCount: number;
  targetAssignmentCount: number;
  targetHeldAcrossNativeSubsteps: boolean;
  peakNativeSpeed: JuPedSimPeakDiagnostic;
  peakNativeAcceleration: JuPedSimPeakDiagnostic;
  minimumArtificialOuterBoundaryClearance: number;
  directSteering: boolean;
  journeyStageCount: number;
  dt: number;
  steps: number;
  agentCount: number;
  scenarioToJuPedSimIds: Array<{ scenarioId: number; jupedsimId: number }>;
}

interface JuPedSimPeakDiagnostic {
  value: number;
  scenarioAgentId: number;
  experimentStepIndex: number;
  nativeSubstepIndex: number;
}

export class JuPedSimSfmEngine implements ExperimentEngine {
  readonly engineId = JUPEDSIM_SFM_ENGINE_ID;

  constructor(readonly methodId: string, readonly methodKey: string) {}

  getProvenance(scenario: ExperimentScenario, method: MethodConfig) {
    if (method.id !== JUPEDSIM_SFM_METHOD_ID) {
      throw new Error("JuPedSim provenance requires its strict SFM method configuration");
    }
    return jupedSimProvenance(scenario, method);
  }

  run(
    scenario: ExperimentScenario,
    method: MethodConfig,
    identity: MethodIdentity,
    sink: EngineStepSink,
  ): EngineRunResult {
    if (
      method.id !== JUPEDSIM_SFM_METHOD_ID
      || method.engine !== JUPEDSIM_SFM_ENGINE_ID
      || identity.methodKey !== this.methodKey
    ) {
      throw new Error("JuPedSim engine received a mismatched method configuration");
    }
    const typed = method as JuPedSimSfmMethodConfig;
    const provenance = this.getProvenance(scenario, method);
    const runtime = baselineRuntimePaths();
    const temporaryDirectory = makeTemporaryDirectory(this.engineId, identity.methodKey);
    const inputPath = resolve(temporaryDirectory, "input.json");
    const outputPath = resolve(temporaryDirectory, "output.jsonl");
    const metadataPath = resolve(temporaryDirectory, "metadata.json");
    const input = createJuPedSimInput(scenario, typed);
    writeFileSync(inputPath, JSON.stringify(input) + "\n", "utf8");
    let succeeded = false;
    try {
      runExternalProcess({
        executable: runtime.jupedsimPython,
        arguments: [
          runtime.jupedsimRunner,
          "--input",
          inputPath,
          "--output",
          outputPath,
          "--metadata",
          metadataPath,
        ],
        temporaryDirectory,
        outputPath,
        environment: {
          ...process.env,
          PYTHONHASHSEED: "0",
          OMP_NUM_THREADS: "1",
          OPENBLAS_NUM_THREADS: "1",
          MKL_NUM_THREADS: "1",
          NUMEXPR_NUM_THREADS: "1",
        },
      });
      const metadata = validateRunnerMetadata(
        metadataPath,
        scenario,
        input.geometrySha256,
        fixedStepCount(scenario),
      );
      if (
        metadata.jupedsimVersion
        !== provenance.engineSpecificProvenance.jupedsimVersion
        || metadata.pythonVersion
        !== provenance.engineSpecificProvenance.pythonVersion
      ) {
        throw new Error("JuPedSim runtime metadata differs from pinned build provenance");
      }
      const finalStates = consumeNativeOutput(scenario, outputPath, "jupedSimSfm", sink);
      succeeded = true;
      return {
        finalStates,
        totalSteps: fixedStepCount(scenario),
        provenance,
        artifactDiagnostics: {
          numericalStability: {
            diagnosticVersion: 1,
            experimentDt: metadata.experimentDt,
            nativeJuPedSimDt: metadata.nativeJuPedSimDt,
            nativeSubstepsPerExperimentStep: metadata.nativeSubstepsPerExperimentStep,
            nativeIterationCount: metadata.nativeIterationCount,
            protocolTargetResolutionCount: metadata.protocolTargetResolutionCount,
            targetAssignmentCount: metadata.targetAssignmentCount,
            targetHeldAcrossNativeSubsteps: metadata.targetHeldAcrossNativeSubsteps,
            peakNativeSpeedMetersPerSecond: metadata.peakNativeSpeed,
            peakNativeAccelerationMetersPerSecondSquared: metadata.peakNativeAcceleration,
            minimumArtificialOuterBoundaryClearanceMeters:
              metadata.minimumArtificialOuterBoundaryClearance,
          },
        },
      };
    } finally {
      if (succeeded) removeSuccessfulTemporaryDirectory(temporaryDirectory);
    }
  }
}

export function createJuPedSimInput(
  scenario: ExperimentScenario,
  method: JuPedSimSfmMethodConfig,
) {
  const geometry = createJuPedSimGeometry(scenario);
  return {
    runnerInputVersion: 1,
    methodId: method.id,
    engineId: method.engine,
    scenarioFamily: scenario.family,
    scenarioVariant: scenario.variant,
    dt: scenario.simulation.dt,
    steps: fixedStepCount(scenario),
    goalTolerance: scenario.simulation.goalTolerance,
    completionSpecVersion: scenario.completion.completionSpecVersion,
    parameters: method.parameters,
    navigation: protocolNavigationRunnerConfig(scenario),
    geometry: geometry.spec,
    geometryCanonicalJson: geometry.canonicalJson,
    geometrySha256: geometry.sha256,
    agents: [...scenario.agents].sort((first, second) => first.id - second.id).map((agent) => ({
      id: agent.id,
      radius: agent.radius,
      preferredSpeed: agent.preferredSpeed,
      position: [agent.position[0], agent.position[1]],
      velocity: [agent.velocity[0], agent.velocity[1]],
      goal: [agent.goal[0], agent.goal[1]],
    })),
  };
}

function validateRunnerMetadata(
  path: string,
  scenario: ExperimentScenario,
  geometrySha256: string,
  steps: number,
): JuPedSimRunnerMetadata {
  if (!existsSync(path)) throw new Error("JuPedSim runner metadata is missing");
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<JuPedSimRunnerMetadata>;
  if (
    value.runnerMetadataVersion !== 2
    || value.jupedsimVersion !== "1.4.2"
    || value.geometrySha256 !== geometrySha256
    || value.directSteering !== true
    || value.journeyStageCount !== 1
    || value.dt !== scenario.simulation.dt
    || value.steps !== steps
    || value.agentCount !== scenario.agents.length
    || typeof value.pythonVersion !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.finalGeometrySha256 ?? "")
    || value.experimentDt !== scenario.simulation.dt
    || value.nativeJuPedSimDt !== scenario.simulation.dt / 2
    || value.nativeSubstepsPerExperimentStep !== 2
    || value.nativeIterationCount !== steps * 2
    || value.protocolTargetResolutionCount !== steps * scenario.agents.length
    || value.targetAssignmentCount !== steps * scenario.agents.length
    || value.targetHeldAcrossNativeSubsteps !== true
    || !validPeakDiagnostic(value.peakNativeSpeed, scenario, steps)
    || !validPeakDiagnostic(value.peakNativeAcceleration, scenario, steps)
    || !Number.isFinite(value.minimumArtificialOuterBoundaryClearance)
    || (value.minimumArtificialOuterBoundaryClearance ?? 0) <= 0
    || !Array.isArray(value.scenarioToJuPedSimIds)
  ) {
    throw new Error("JuPedSim runner metadata is malformed or inconsistent");
  }
  const expectedIds = scenario.agents.map((agent) => agent.id).sort((first, second) => first - second);
  const mappings = value.scenarioToJuPedSimIds;
  const actualIds = mappings.map((entry) => entry.scenarioId);
  const nativeIds = mappings.map((entry) => entry.jupedsimId);
  if (
    JSON.stringify(actualIds) !== JSON.stringify(expectedIds)
    || new Set(nativeIds).size !== nativeIds.length
    || nativeIds.some((id) => !Number.isSafeInteger(id))
  ) {
    throw new Error("JuPedSim runner ID mapping is incomplete or unstable");
  }
  return value as JuPedSimRunnerMetadata;
}

function validPeakDiagnostic(
  value: JuPedSimPeakDiagnostic | undefined,
  scenario: ExperimentScenario,
  steps: number,
): value is JuPedSimPeakDiagnostic {
  return value !== undefined
    && Number.isFinite(value.value)
    && value.value >= 0
    && scenario.agents.some((agent) => agent.id === value.scenarioAgentId)
    && Number.isSafeInteger(value.experimentStepIndex)
    && value.experimentStepIndex >= 0
    && value.experimentStepIndex < steps
    && Number.isSafeInteger(value.nativeSubstepIndex)
    && value.nativeSubstepIndex >= 0
    && value.nativeSubstepIndex < 2;
}
