import type { SimulatorCore } from "../../src/core/SimulatorCore";
import type { StepDiagnostics } from "../../src/core/types";
import type { TrajectoryRecord } from "./types";

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
      intendedDisplacement: diagnostic.intendedDisplacement,
      agentCorrectionDisplacement: diagnostic.agentCorrectionDisplacement,
      wallCorrectionDisplacement: diagnostic.wallCorrectionDisplacement,
      totalCorrectionDisplacement: diagnostic.totalCorrectionDisplacement,
      correctionRatio: diagnostic.correctionRatio,
      coincidentNeighborContributionsSkipped: diagnostic.coincidentNeighborContributionsSkipped,
    },
  };
}
