import type { SimulatorCore } from "../../src/core/SimulatorCore";
import type { StepDiagnostics } from "../../src/core/types";
import type { TrajectoryRecord } from "./types";
import type { EngineStepRecord } from "../engines/engineStep";

export function toTrajectoryRecord(
  diagnostic: StepDiagnostics,
  states: ReturnType<SimulatorCore["getAgents"]>,
): TrajectoryRecord {
  const targetById = new Map(diagnostic.perAgent.map((entry) => [entry.id, entry.targetVelocity]));
  return {
    stepIndex: diagnostic.stepIndex,
    time: diagnostic.time,
    agents: states.map((agent) => ({
      id: agent.id,
      position: agent.position,
      realizedVelocity: agent.velocity,
      targetVelocity: targetById.get(agent.id) ?? [0, 0],
      arrived: agent.arrived,
    })),
    diagnostics: {
      preCorrectionOverlapPairs: diagnostic.preCorrectionOverlapPairs,
      postCorrectionOverlapPairs: diagnostic.postCorrectionOverlapPairs,
      preCorrectionWallContacts: diagnostic.preCorrectionWallContacts,
      postCorrectionWallContacts: diagnostic.postCorrectionWallContacts,
      maxPreCorrectionPenetration: diagnostic.maxPreCorrectionPenetration,
      maxPostCorrectionPenetration: diagnostic.maxPostCorrectionPenetration,
      maximumPreCorrectionAgentPenetration:
        diagnostic.maximumPreCorrectionAgentPenetration,
      maximumPreCorrectionWallPenetration:
        diagnostic.maximumPreCorrectionWallPenetration,
      maximumPostCorrectionAgentPenetration:
        diagnostic.maximumPostCorrectionAgentPenetration,
      maximumPostCorrectionWallPenetration:
        diagnostic.maximumPostCorrectionWallPenetration,
      minimumPreCorrectionAgentClearance:
        diagnostic.minimumPreCorrectionAgentClearance,
      minimumPreCorrectionWallClearance:
        diagnostic.minimumPreCorrectionWallClearance,
      intendedDisplacement: diagnostic.intendedDisplacement,
      agentCorrectionDisplacement: diagnostic.agentCorrectionDisplacement,
      wallCorrectionDisplacement: diagnostic.wallCorrectionDisplacement,
      totalCorrectionDisplacement: diagnostic.totalCorrectionDisplacement,
      correctionRatio: diagnostic.correctionRatio,
      coincidentNeighborContributionsSkipped: diagnostic.coincidentNeighborContributionsSkipped,
    },
  };
}

export function engineStepToTrajectoryRecord(record: EngineStepRecord): TrajectoryRecord {
  const maximumPre = Math.max(
    record.diagnostics.maximumPreCorrectionAgentPenetration,
    record.diagnostics.maximumPreCorrectionWallPenetration,
  );
  const maximumPost = Math.max(
    record.diagnostics.maximumPostCorrectionAgentPenetration,
    record.diagnostics.maximumPostCorrectionWallPenetration,
  );
  const ratio =
    record.diagnostics.totalCorrectionDisplacement /
    (record.diagnostics.intendedDisplacement + 1e-12);
  return {
    engineStepVersion: record.engineStepVersion,
    stepIndex: record.stepIndex,
    time: record.time,
    agents: record.agents.map((agent) => ({
      id: agent.id,
      position: agent.postCorrectionPosition,
      realizedVelocity: agent.realizedVelocity,
      targetVelocity: agent.commandVelocity,
      commandVelocity: agent.commandVelocity,
      arrived: agent.arrived,
    })),
    diagnostics: {
      preCorrectionOverlapPairs: record.diagnostics.preCorrectionOverlapPairs,
      postCorrectionOverlapPairs: record.diagnostics.postCorrectionOverlapPairs,
      preCorrectionWallContacts: record.diagnostics.preCorrectionWallContacts,
      postCorrectionWallContacts: record.diagnostics.postCorrectionWallContacts,
      maxPreCorrectionPenetration: maximumPre,
      maxPostCorrectionPenetration: maximumPost,
      maximumPreCorrectionAgentPenetration:
        record.diagnostics.maximumPreCorrectionAgentPenetration,
      maximumPreCorrectionWallPenetration:
        record.diagnostics.maximumPreCorrectionWallPenetration,
      maximumPostCorrectionAgentPenetration:
        record.diagnostics.maximumPostCorrectionAgentPenetration,
      maximumPostCorrectionWallPenetration:
        record.diagnostics.maximumPostCorrectionWallPenetration,
      minimumPreCorrectionAgentClearance:
        record.diagnostics.minimumPreCorrectionAgentClearance,
      minimumPreCorrectionWallClearance:
        record.diagnostics.minimumPreCorrectionWallClearance,
      intendedDisplacement: record.diagnostics.intendedDisplacement,
      agentCorrectionDisplacement: record.diagnostics.agentCorrectionDisplacement,
      wallCorrectionDisplacement: record.diagnostics.wallCorrectionDisplacement,
      totalCorrectionDisplacement: record.diagnostics.totalCorrectionDisplacement,
      correctionRatio: ratio,
      coincidentNeighborContributionsSkipped: 0,
    },
  };
}
