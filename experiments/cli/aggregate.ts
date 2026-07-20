import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { RunMetrics } from "../metrics/types";
import {
  BATCH_MANIFEST_VERSION,
  type BatchManifest,
  type BatchRunRecord,
} from "./runBatch";

const RUN_HEADERS = [
  "scenario_name",
  "family",
  "variant",
  "split",
  "seed",
  "method_key",
  "method_id",
  "engine_id",
  "engine_adapter_version",
  "correction_mode",
  "command_velocity_meaning",
  "method_identity_version",
  "method_config_canonical_sha256",
  "method_config_source_sha256",
  "method_config_sha256",
  "upstream_project",
  "upstream_commit",
  "upstream_license",
  "velocity_time_constant",
  "alpha",
  "sigma",
  "lambda_r",
  "lambda_t",
  "orca_neighbor_dist",
  "orca_max_neighbors",
  "orca_time_horizon",
  "orca_time_horizon_obst",
  "sfm_desired_factor",
  "sfm_relaxation_time",
  "sfm_social_factor",
  "sfm_lambda_importance",
  "sfm_gamma",
  "sfm_n",
  "sfm_n_prime",
  "sfm_obstacle_factor",
  "sfm_obstacle_sigma",
  "sfm_obstacle_threshold",
  "sfm_max_speed_multiplier",
  "sfm_obstacle_resolution",
  "agent_count",
  "success_fraction",
  "legacy_point_goal_success_fraction",
  "mean_normalized_completion_time",
  "mean_path_efficiency",
  "minimum_pre_correction_agent_clearance",
  "minimum_pre_correction_wall_clearance",
  "maximum_pre_correction_agent_penetration",
  "maximum_post_correction_agent_penetration",
  "maximum_pre_correction_wall_penetration",
  "maximum_post_correction_wall_penetration",
  "pre_correction_overlap_pair_seconds",
  "post_correction_overlap_pair_seconds",
  "correction_ratio",
  "rms_acceleration",
  "rms_jerk",
  "throughput",
  "pairwise_onset_time_agent_0",
  "pairwise_ttc_agent_0",
  "pairwise_onset_time_agent_1",
  "pairwise_ttc_agent_1",
  "pairwise_minimum_pre_correction_center_distance",
  "pairwise_minimum_pre_correction_physical_clearance",
  "pairwise_minimum_post_correction_center_distance",
  "pairwise_minimum_post_correction_physical_clearance",
] as const;

export interface AggregateOptions {
  inputDirectory: string;
  outputDirectory: string;
}

export interface AggregateResult {
  runMetricsCsvPath: string;
  failuresCsvPath: string;
  completedRows: number;
  failureRows: number;
}

export function aggregateBatch(options: AggregateOptions): AggregateResult {
  const inputDirectory = resolve(options.inputDirectory);
  const outputDirectory = resolve(options.outputDirectory);
  const manifest = JSON.parse(
    readFileSync(resolve(inputDirectory, "batch-manifest.json"), "utf8"),
  ) as BatchManifest;
  if (
    ![3, BATCH_MANIFEST_VERSION].includes(manifest.batchManifestVersion) ||
    !Array.isArray(manifest.runs)
  ) {
    throw new Error("Unsupported or malformed batch manifest");
  }
  const completedRuns = manifest.runs.filter(
    (run) => run.status === "completed" || run.status === "skipped",
  );
  const failedRuns = manifest.runs.filter((run) => run.status === "failed");
  const rows = completedRuns.map((run) => metricsRow(loadMetrics(run)));
  mkdirSync(outputDirectory, { recursive: true });
  const runMetricsCsvPath = resolve(outputDirectory, "run-metrics.csv");
  const failuresCsvPath = resolve(outputDirectory, "failures.csv");
  writeFileSync(
    runMetricsCsvPath,
    `${RUN_HEADERS.join(",")}\n${rows.map((row) => row.map(csvValue).join(",")).join("\n")}${rows.length > 0 ? "\n" : ""}`,
    "utf8",
  );
  const failureHeaders = [
    "scenario_path",
    "method_key",
    "method_id",
    "engine_id",
    "method_identity_version",
    "method_config_canonical_sha256",
    "method_config_source_sha256",
    "method_config_sha256",
    "output_directory",
    "error",
  ];
  const failureRows = failedRuns.map((run) => [
    run.scenarioPath,
    run.methodKey,
    run.methodId,
    run.engineId,
    run.methodIdentityVersion,
    run.methodConfigCanonicalSha256,
    run.methodConfigSourceSha256,
    run.methodConfigSha256,
    run.outputDirectory,
    run.error,
  ]);
  writeFileSync(
    failuresCsvPath,
    `${failureHeaders.join(",")}\n${failureRows.map((row) => row.map(csvValue).join(",")).join("\n")}${failureRows.length > 0 ? "\n" : ""}`,
    "utf8",
  );
  return {
    runMetricsCsvPath,
    failuresCsvPath,
    completedRows: rows.length,
    failureRows: failureRows.length,
  };
}

function loadMetrics(run: BatchRunRecord): RunMetrics {
  const metrics = JSON.parse(
    readFileSync(resolve(run.outputDirectory, "run-metrics.json"), "utf8"),
  ) as RunMetrics;
  if (
    metrics.identity.methodKey !== run.methodKey ||
    metrics.identity.methodId !== run.methodId ||
    metrics.identity.engineId !== run.engineId ||
    metrics.identity.methodIdentityVersion !== run.methodIdentityVersion ||
    metrics.identity.methodConfigCanonicalSha256 !== run.methodConfigCanonicalSha256
  ) {
    throw new Error(`Run metrics identity does not match batch record: ${run.outputDirectory}`);
  }
  return metrics;
}

function metricsRow(metrics: RunMetrics): unknown[] {
  const pairwise = metrics.pairwise;
  const firstPair = pairwise?.perAgent[0];
  const secondPair = pairwise?.perAgent[1];
  return [
    metrics.identity.scenarioName,
    metrics.identity.family,
    metrics.identity.variant,
    metrics.identity.split,
    metrics.identity.seed,
    metrics.identity.methodKey,
    metrics.identity.methodId,
    metrics.identity.engineId,
    metrics.identity.engineAdapterVersion,
    metrics.identity.correctionMode,
    metrics.identity.commandVelocityMeaning,
    metrics.identity.methodIdentityVersion,
    metrics.identity.methodConfigCanonicalSha256,
    metrics.identity.methodConfigSourceSha256,
    metrics.identity.methodConfigSha256,
    metrics.identity.upstreamProject,
    metrics.identity.upstreamCommit,
    metrics.identity.upstreamLicense,
    metrics.identity.velocityTimeConstant,
    numericParameter(metrics, "alpha"),
    numericParameter(metrics, "sigma"),
    numericParameter(metrics, "lambdaR"),
    numericParameter(metrics, "lambdaT"),
    numericParameter(metrics, "neighborDist"),
    numericParameter(metrics, "maxNeighbors"),
    numericParameter(metrics, "timeHorizon"),
    numericParameter(metrics, "timeHorizonObst"),
    numericParameter(metrics, "desiredFactor"),
    numericParameter(metrics, "relaxationTime"),
    numericParameter(metrics, "socialFactor"),
    numericParameter(metrics, "lambdaImportance"),
    numericParameter(metrics, "gamma"),
    numericParameter(metrics, "n"),
    numericParameter(metrics, "nPrime"),
    numericParameter(metrics, "obstacleFactor"),
    numericParameter(metrics, "obstacleSigma"),
    numericParameter(metrics, "obstacleThreshold"),
    numericParameter(metrics, "maxSpeedMultiplier"),
    numericParameter(metrics, "obstacleResolution"),
    metrics.identity.agentCount,
    metrics.completion.successFraction,
    metrics.completion.legacyPointGoalSuccessFraction,
    metrics.completionTime.meanNormalizedCompletionTime,
    metrics.pathEfficiency.meanPathEfficiency,
    metrics.separation.minimumPreCorrectionAgentClearance,
    metrics.separation.minimumPreCorrectionWallClearance,
    metrics.separation.maximumPreCorrectionAgentPenetration,
    metrics.separation.maximumPostCorrectionAgentPenetration,
    metrics.separation.maximumPreCorrectionWallPenetration,
    metrics.separation.maximumPostCorrectionWallPenetration,
    metrics.separation.totalPreCorrectionOverlapPairSeconds,
    metrics.separation.totalPostCorrectionOverlapPairSeconds,
    metrics.correctionDependence.correctionRatio,
    metrics.smoothness.rmsAcceleration,
    metrics.smoothness.rmsJerk,
    metrics.throughput,
    firstPair?.avoidanceOnsetTime ?? null,
    firstPair?.ttcAtAvoidanceOnset ?? null,
    secondPair?.avoidanceOnsetTime ?? null,
    secondPair?.ttcAtAvoidanceOnset ?? null,
    pairwise?.minimumPreCorrectionCenterDistance ?? null,
    pairwise?.minimumPreCorrectionPhysicalClearance ?? null,
    pairwise?.minimumPostCorrectionCenterDistance ?? null,
    pairwise?.minimumPostCorrectionPhysicalClearance ?? null,
  ];
}

function numericParameter(metrics: RunMetrics, key: string): number | null {
  const value = metrics.identity.methodParameters[key];
  if (value === undefined) return null;
  if (!Number.isFinite(value)) throw new Error(`Non-finite method parameter: ${key}`);
  return value;
}

function csvValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("CSV aggregation encountered a non-finite number");
  }
  const text = String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function parseArguments(arguments_: readonly string[]): AggregateOptions {
  let inputDirectory: string | undefined;
  let outputDirectory: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (argument === "--input" && value !== undefined) {
      inputDirectory = value;
      index += 1;
    } else if (argument === "--out" && value !== undefined) {
      outputDirectory = value;
      index += 1;
    } else throw new Error(`Unknown or incomplete argument: ${argument}`);
  }
  if (inputDirectory === undefined) throw new Error("Missing required --input directory");
  if (outputDirectory === undefined) throw new Error("Missing required --out directory");
  return { inputDirectory, outputDirectory };
}

function main(): void {
  try {
    const result = aggregateBatch(parseArguments(process.argv.slice(2)));
    console.log(`exp:aggregate rows=${result.completedRows} failures=${result.failureRows}`);
  } catch (error) {
    console.error(`exp:aggregate failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) main();
