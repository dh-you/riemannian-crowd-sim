import { SimulatorCore } from "../../src/core/SimulatorCore";
import type { MethodIdentity } from "../protocol/methodIdentity";
import {
  controllerParametersFromMethod,
  isScientificMethod,
  SCIENTIFIC_CORE_ENGINE_ID,
  type MethodConfig,
} from "../protocol/methodConfig";
import type { ExperimentScenario } from "../protocol/schema";
import { resolveProtocolTarget } from "../protocol/completion";
import { fixedStepCount } from "../cli/runScenario";
import {
  SCIENTIFIC_CORE_ADAPTER_VERSION,
  type EngineRunResult,
  type EngineStepSink,
  type ExperimentEngine,
} from "./ExperimentEngine";
import { scientificDiagnosticToEngineStep } from "./engineStep";

export class ScientificCoreEngine implements ExperimentEngine {
  readonly engineId = SCIENTIFIC_CORE_ENGINE_ID;

  constructor(
    readonly methodId: string,
    readonly methodKey: string,
  ) {}

  getProvenance(scenario: ExperimentScenario, method: MethodConfig) {
    if (!isScientificMethod(method)) throw new Error("Scientific Core provenance requires a scientific method");
    return {
      engineId: this.engineId,
      engineAdapterVersion: SCIENTIFIC_CORE_ADAPTER_VERSION,
      correctionMode: scenario.simulation.correction.enabled ? "shared_projection" as const : "disabled" as const,
      commandVelocityMeaning: "controller target velocity before Scientific Core smoothing",
      thirdPartyLockSha256: null,
      upstreamProject: null,
      upstreamRepository: null,
      upstreamCommit: null,
      upstreamLicense: null,
      runnerPath: null,
      runnerSha256: null,
      buildManifestSha256: null,
      limitations: [],
    };
  }

  run(
    scenario: ExperimentScenario,
    method: MethodConfig,
    identity: MethodIdentity,
    sink: EngineStepSink,
  ): EngineRunResult {
    if (!isScientificMethod(method) || method.id !== this.methodId || identity.methodKey !== this.methodKey) {
      throw new Error("Scientific Core engine received a mismatched method configuration");
    }
    const simulator = new SimulatorCore({
      agents: scenario.agents,
      walls: scenario.walls,
      simulation: {
        dt: scenario.simulation.dt,
        goalTolerance: scenario.simulation.goalTolerance,
        velocityTimeConstant: method.velocityTimeConstant,
        correction: scenario.simulation.correction,
      },
      controller: controllerParametersFromMethod(method),
    });
    const totalSteps = fixedStepCount(
      scenario.simulation.horizonSeconds,
      scenario.simulation.dt,
    );
    const correctionMode = scenario.simulation.correction.enabled
      ? "shared_projection"
      : "disabled";
    for (let index = 0; index < totalSteps; index += 1) {
      const before = simulator.getAgents();
      const navigationTargets = new Map(before.map((agent) => [
        agent.id,
        resolveProtocolTarget(scenario, agent),
      ]));
      const diagnostic = simulator.step(navigationTargets);
      const after = simulator.getAgents();
      sink(scientificDiagnosticToEngineStep(
        before,
        diagnostic,
        after,
        correctionMode,
        navigationTargets,
      ));
    }
    return {
      finalStates: simulator.getAgents(),
      totalSteps,
      provenance: { ...this.getProvenance(scenario, method), correctionMode },
    };
  }
}
