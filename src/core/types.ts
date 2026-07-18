export type Vec2 = readonly [number, number];

export interface Mat2 {
  readonly xx: number;
  readonly xy: number;
  readonly yx: number;
  readonly yy: number;
}

export const CONTROLLER_ID = "conditioned_riemannian_metric_v1" as const;
export const EUCLIDEAN_GOAL_CONTROLLER_ID = "euclidean_goal_steering_v1" as const;

export interface AgentState {
  id: number;
  position: Vec2;
  velocity: Vec2;
  goal: Vec2;
  radius: number;
  preferredSpeed: number;
  arrived: boolean;
}

export interface WallSegment {
  id: number;
  start: Vec2;
  end: Vec2;
  thickness: number;
}

export interface RiemannianControllerParameters {
  id: typeof CONTROLLER_ID;
  alpha: number;
  sigma: number;
  lambdaR: number;
  lambdaT: number;
}

/** Backward-compatible Stage A name for the Riemannian parameter object. */
export type ControllerParameters = RiemannianControllerParameters;

export interface EuclideanGoalControllerParameters {
  id: typeof EUCLIDEAN_GOAL_CONTROLLER_ID;
}

export type ScientificControllerParameters =
  | RiemannianControllerParameters
  | EuclideanGoalControllerParameters;

export interface CorrectionParameters {
  enabled: boolean;
  iterations: number;
  padding: number;
}

export interface SimulationParameters {
  dt: number;
  goalTolerance: number;
  velocityTimeConstant: number;
  correction: CorrectionParameters;
}

export interface PerAgentStepDiagnostics {
  id: number;
  targetVelocity: Vec2;
  smoothedVelocity: Vec2;
  realizedVelocity: Vec2;
  preCorrectionPosition: Vec2;
  postCorrectionPosition: Vec2;
  agentCorrectionDisplacement: number;
  wallCorrectionDisplacement: number;
}

export interface StepDiagnostics {
  /** Zero-based index of the completed step. */
  stepIndex: number;
  /** Physical simulation time after this step, in seconds. */
  time: number;

  preCorrectionOverlapPairs: number;
  postCorrectionOverlapPairs: number;
  preCorrectionWallContacts: number;
  postCorrectionWallContacts: number;

  /** @deprecated Combined agent/wall maximum retained for Stage A compatibility. */
  maxPreCorrectionPenetration: number;
  /** @deprecated Combined agent/wall maximum retained for Stage A compatibility. */
  maxPostCorrectionPenetration: number;
  /** @deprecated Use maximumPreCorrectionWallPenetration. */
  maxPreCorrectionWallPenetration: number;
  /** @deprecated Use maximumPostCorrectionWallPenetration. */
  maxPostCorrectionWallPenetration: number;
  maximumPreCorrectionAgentPenetration: number;
  maximumPreCorrectionWallPenetration: number;
  maximumPostCorrectionAgentPenetration: number;
  maximumPostCorrectionWallPenetration: number;
  totalPreCorrectionOverlapPenetration: number;
  totalPostCorrectionOverlapPenetration: number;
  totalPreCorrectionWallPenetration: number;
  totalPostCorrectionWallPenetration: number;
  /** @deprecated Combined agent/wall minimum retained for Stage A compatibility. */
  minimumPreCorrectionClearance: number | null;
  minimumPreCorrectionAgentClearance: number | null;
  minimumPreCorrectionWallClearance: number | null;

  correctedAgentPairs: number;
  correctedWallContacts: number;

  intendedDisplacement: number;
  agentCorrectionDisplacement: number;
  wallCorrectionDisplacement: number;
  totalCorrectionDisplacement: number;
  correctionRatio: number;

  coincidentNeighborContributionsSkipped: number;
  perAgent: PerAgentStepDiagnostics[];
}

export interface ContactMeasurements {
  overlapPairs: number;
  wallContacts: number;
  maxAgentPenetration: number;
  maxWallPenetration: number;
  totalAgentPenetration: number;
  totalWallPenetration: number;
  /** @deprecated Combined agent/wall minimum retained for Stage A compatibility. */
  minimumClearance: number | null;
  minimumAgentClearance: number | null;
  minimumWallClearance: number | null;
}
