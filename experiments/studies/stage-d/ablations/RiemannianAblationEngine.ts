import type { AgentState } from "../../../../src/core/types";
import { fixedStepCount } from "../../../cli/runScenario";
import type { EngineStepRecord } from "../../../engines/engineStep";
import { scientificDiagnosticToEngineStep } from "../../../engines/engineStep";
import type { ExperimentScenario } from "../../../protocol/schema";
import type { RiemannianAblationConfig } from "./config";
import { RiemannianAblationSimulator } from "./RiemannianAblationSimulator";

export interface RiemannianAblationRunResult {
  finalStates: AgentState[];
  totalSteps: number;
}

export function runRiemannianAblation(
  scenario: ExperimentScenario,
  config: RiemannianAblationConfig,
  sink: (record: EngineStepRecord) => void,
): RiemannianAblationRunResult {
  const simulator = new RiemannianAblationSimulator(scenario, config);
  const totalSteps = fixedStepCount(
    scenario.simulation.horizonSeconds,
    scenario.simulation.dt,
  );
  const correctionMode = scenario.simulation.correction.enabled
    ? "shared_projection"
    : "disabled";
  for (let index = 0; index < totalSteps; index += 1) {
    const before = simulator.getAgents();
    const diagnostic = simulator.step();
    const after = simulator.getAgents();
    sink(scientificDiagnosticToEngineStep(before, diagnostic, after, correctionMode));
  }
  return { finalStates: simulator.getAgents(), totalSteps };
}
