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
  minimumPreCorrectionCenterDistance: number | null;
  minimumPreCorrectionPhysicalClearance: number | null;
  minimumPostCorrectionCenterDistance: number | null;
  minimumPostCorrectionPhysicalClearance: number | null;
}

export interface RunMethodMetadata {
  methodId: string;
  methodKey: string;
  methodConfigSha256: string;
  velocityTimeConstant: number;
  methodParameters: Readonly<Record<string, number>>;
}

export interface RunMetrics {
  identity: {
    scenarioName: string;
    family: string;
    variant: string;
    split: string;
    seed: number;
    methodId: string;
    methodKey: string;
    methodConfigSha256: string;
    velocityTimeConstant: number;
    methodParameters: Readonly<Record<string, number>>;
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
    minimumPreCorrectionAgentClearance: number | null;
    minimumPreCorrectionWallClearance: number | null;
    totalPreCorrectionOverlapPairSeconds: number;
    totalPostCorrectionOverlapPairSeconds: number;
    preCorrectionOverlapPairSecondsPerAgentSecond: number | null;
    maximumPreCorrectionAgentPenetration: number;
    maximumPreCorrectionWallPenetration: number;
    maximumPostCorrectionAgentPenetration: number;
    maximumPostCorrectionWallPenetration: number;
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
