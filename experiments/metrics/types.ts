export interface PerAgentOutcomeMetrics {
  id: number;
  firstArrivalTime: number | null;
  normalizedTravelTime: number | null;
  pathEfficiency: number | null;
}

export interface PairwiseAgentMetrics {
  id: number;
  avoidanceOnsetTime: number | null;
  ttcAtAvoidanceOnset: number | null;
}

export interface PairwiseMetrics {
  avoidanceThresholdDegrees: number;
  perAgent: PairwiseAgentMetrics[];
  minimumCenterClearance: number | null;
  minimumPhysicalClearance: number | null;
}

export interface RunMetrics {
  identity: {
    scenarioName: string;
    family: string;
    variant: string;
    split: string;
    seed: number;
    methodId: string;
    agentCount: number;
    simulatedDuration: number;
  };
  completion: {
    agentsReachedGoal: number;
    successFraction: number;
    finalArrivedFraction: number;
    perAgent: PerAgentOutcomeMetrics[];
  };
  travelTime: {
    meanNormalizedTravelTime: number | null;
    medianNormalizedTravelTime: number | null;
  };
  pathEfficiency: {
    meanPathEfficiency: number | null;
    medianPathEfficiency: number | null;
  };
  separation: {
    minimumPreCorrectionClearance: number | null;
    totalPreCorrectionOverlapPairSeconds: number;
    totalPostCorrectionOverlapPairSeconds: number;
    preCorrectionOverlapPairSecondsPerAgentSecond: number | null;
    maximumPreCorrectionPenetration: number;
    maximumPostCorrectionPenetration: number;
  };
  correctionDependence: {
    totalIntendedDisplacement: number;
    totalAgentCorrectionDisplacement: number;
    totalWallCorrectionDisplacement: number;
    totalCorrectionDisplacement: number;
    correctionRatio: number;
  };
  smoothness: {
    rmsAcceleration: number | null;
    rmsJerk: number | null;
    accelerationSampleCount: number;
    jerkSampleCount: number;
  };
  throughput: number | null;
  pairwise: PairwiseMetrics | null;
}
