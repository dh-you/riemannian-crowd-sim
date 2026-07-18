import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { RunMetrics } from "../metrics/types";
import type { BatchManifest, BatchRunRecord } from "./runBatch";

const RUN_HEADERS = [
  "scenario_name",
  "family",
  "variant",
  "split",
  "seed",
  "method_id",
  "agent_count",
  "success_fraction",
  "mean_normalized_travel_time",
  "mean_path_efficiency",
  "minimum_pre_correction_clearance",
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
  "pairwise_minimum_center_clearance",
  "pairwise_minimum_physical_clearance",
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
  if (manifest.batchManifestVersion !== 1 || !Array.isArray(manifest.runs)) {
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
  const failureHeaders = ["scenario_path", "method_id", "output_directory", "error"];
  const failureRows = failedRuns.map((run) => [
    run.scenarioPath,
    run.methodId,
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
  return JSON.parse(readFileSync(resolve(run.outputDirectory, "run-metrics.json"), "utf8")) as RunMetrics;
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
    metrics.identity.methodId,
    metrics.identity.agentCount,
    metrics.completion.successFraction,
    metrics.travelTime.meanNormalizedTravelTime,
    metrics.pathEfficiency.meanPathEfficiency,
    metrics.separation.minimumPreCorrectionClearance,
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
    pairwise?.minimumCenterClearance ?? null,
    pairwise?.minimumPhysicalClearance ?? null,
  ];
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
