export interface PerAgentOutcomeMetrics {
  id: number;
  completionType: "goal_disk" | "directional_line";
  idealCompletionDistance: number;
  firstCompletionTime: number | null;
  normalizedCompletionTime: number | null;
  legacyFirstPointGoalArrivalTime: number | null;
  minimumDistanceToPointGoal: number;
  finalDistanceToPointGoal: number;
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
  methodIdentityVersion?: number;
  methodConfigCanonicalSha256?: string;
  methodConfigSourceSha256?: string;
  engineId?: string;
  engineAdapterVersion?: string;
  correctionMode?: string;
  commandVelocityMeaning?: string;
  upstreamProject?: string | null;
  upstreamCommit?: string | null;
  upstreamLicense?: string | null;
  methodConfigSha256: string;
  velocityTimeConstant: number | null;
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
    methodIdentityVersion: number;
    methodConfigCanonicalSha256: string;
    methodConfigSourceSha256: string;
    methodConfigSha256: string;
    engineId: string;
    engineAdapterVersion: string;
    correctionMode: string;
    commandVelocityMeaning: string;
    upstreamProject: string | null;
    upstreamCommit: string | null;
    upstreamLicense: string | null;
    velocityTimeConstant: number | null;
    methodParameters: Readonly<Record<string, number>>;
    agentCount: number;
    simulatedDuration: number;
  };
  completion: {
    completionRuleType: "goal_disk" | "directional_line" | "per_agent_directional_line";
    completedAgents: number;
    successFraction: number;
    legacyPointGoalCompletedAgents: number;
    legacyPointGoalSuccessFraction: number;
    legacyFinalPointGoalArrivedFraction: number;
    preCorrectionGoalDiskEntries: number;
    postCorrectionGoalDiskEntries: number;
    correctionEjectedGoalDiskEntries: number;
    perAgent: PerAgentOutcomeMetrics[];
  };
  completionTime: {
    meanNormalizedCompletionTime: number | null;
    medianNormalizedCompletionTime: number | null;
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
