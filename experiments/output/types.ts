import type { AgentState, ControllerParameters, Vec2 } from "../../src/core/types";

export interface RunManifest {
  scenarioName: string;
  scenarioSchemaVersion: number;
  controllerId: string;
  controllerParameters: ControllerParameters;
  timestepSeconds: number;
  horizonSeconds: number;
  seed: number;
  nodeVersion: string;
  operatingSystem: string;
  architecture: string;
  gitCommitSha: string | null;
  executionTimestamp: string;
  commandArguments: string[];
  recordingInterval: number;
}

export interface TrajectoryAgent {
  id: number;
  position: Vec2;
  realizedVelocity: Vec2;
  targetVelocity: Vec2;
  arrived: boolean;
}

export interface TrajectoryRecord {
  stepIndex: number;
  time: number;
  agents: TrajectoryAgent[];
  diagnostics: {
    preCorrectionOverlapPairs: number;
    postCorrectionOverlapPairs: number;
    preCorrectionWallContacts: number;
    postCorrectionWallContacts: number;
    maxPreCorrectionPenetration: number;
    maxPostCorrectionPenetration: number;
    intendedDisplacement: number;
    agentCorrectionDisplacement: number;
    wallCorrectionDisplacement: number;
    totalCorrectionDisplacement: number;
    correctionRatio: number;
    coincidentNeighborContributionsSkipped: number;
  };
}

export interface RunSummary {
  scenarioName: string;
  totalSteps: number;
  simulatedDuration: number;
  arrivedAgents: number;
  arrivedFraction: number;
  minimumPreCorrectionClearance: number | null;
  totalPreCorrectionOverlapExposure: number;
  totalPostCorrectionOverlapExposure: number;
  totalPreCorrectionPenetrationExposure: number;
  totalPostCorrectionPenetrationExposure: number;
  totalPreCorrectionWallPenetrationExposure: number;
  totalPostCorrectionWallPenetrationExposure: number;
  totalIntendedDisplacement: number;
  totalAgentCorrectionDisplacement: number;
  totalWallCorrectionDisplacement: number;
  totalCorrectionDisplacement: number;
  totalCorrectionRatio: number;
  nonFiniteValueOccurred: boolean;
  perAgentFinalState: AgentState[];
}
