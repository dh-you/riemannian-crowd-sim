import type { AgentState } from "../../src/core/types";
import type { MethodIdentity } from "../protocol/methodIdentity";
import type { MethodConfig } from "../protocol/methodConfig";
import type { ExperimentScenario } from "../protocol/schema";
import type { CorrectionMode, EngineStepRecord } from "./engineStep";

export const SCIENTIFIC_CORE_ADAPTER_VERSION = "2";
export const ORCA_ADAPTER_VERSION = "3";
export const SOCIAL_FORCE_ADAPTER_VERSION = "3";
export const JUPEDSIM_SFM_ADAPTER_VERSION = "1";

export interface EngineProvenance {
  engineId: string;
  engineAdapterVersion: string;
  correctionMode: CorrectionMode;
  commandVelocityMeaning: string;
  thirdPartyLockSha256: string | null;
  upstreamProject: string | null;
  upstreamRepository: string | null;
  upstreamCommit: string | null;
  upstreamLicense: string | null;
  runnerPath: string | null;
  runnerSha256: string | null;
  buildManifestSha256: string | null;
  engineSpecificProvenance: Record<string, unknown>;
  limitations: string[];
}

export interface EngineRunResult {
  finalStates: AgentState[];
  totalSteps: number;
  provenance: EngineProvenance;
}

export type EngineStepSink = (record: EngineStepRecord) => void;

export interface ExperimentEngine {
  readonly engineId: string;
  readonly methodId: string;
  readonly methodKey: string;
  getProvenance(scenario: ExperimentScenario, method: MethodConfig): EngineProvenance;
  run(
    scenario: ExperimentScenario,
    method: MethodConfig,
    identity: MethodIdentity,
    sink: EngineStepSink,
  ): EngineRunResult;
}
