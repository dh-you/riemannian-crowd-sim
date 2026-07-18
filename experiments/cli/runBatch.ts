import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sha256Bytes, sha256File } from "../protocol/hash";
import { identifyMethod } from "../protocol/methodIdentity";
import { parseMethodConfig, type MethodConfig } from "../protocol/methodConfig";
import type { SuiteManifest } from "../generation/suite";
import type { RunMetrics } from "../metrics/types";
import { createExperimentEngine } from "../engines/factory";
import type { EngineProvenance } from "../engines/ExperimentEngine";
import { parseExperimentScenario } from "../protocol/schema";
import {
  runExperiment,
  type ExperimentManifest,
  type ExperimentRunSummary,
} from "./runExperiment";

export const BATCH_MANIFEST_VERSION = 3 as const;

export interface BatchRunRecord {
  scenarioPath: string;
  methodPath: string;
  outputDirectory: string;
  scenarioSha256: string;
  methodIdentityVersion: number;
  methodConfigCanonicalSha256: string;
  methodConfigSourceSha256: string;
  /** @deprecated Canonical hash alias. */
  methodConfigSha256: string;
  methodId: string;
  methodKey: string;
  engineId: string;
  engineAdapterVersion: string;
  thirdPartyLockSha256: string | null;
  upstreamCommit: string | null;
  runnerSha256: string | null;
  status: "completed" | "skipped" | "failed";
  error: string | null;
}

export interface BatchManifest {
  batchManifestVersion: typeof BATCH_MANIFEST_VERSION;
  suiteManifestPath: string;
  suiteManifestSha256: string;
  gitCommitSha: string | null;
  split: string;
  resume: boolean;
  force: boolean;
  allowCrossCommitResume: boolean;
  failFast: boolean;
  runs: BatchRunRecord[];
}

export interface RunBatchOptions {
  suiteManifestPath: string;
  methodPaths: string[];
  split: string;
  outputDirectory: string;
  resume?: boolean;
  force?: boolean;
  allowCrossCommitResume?: boolean;
  failFast?: boolean;
}

export interface RunBatchResult {
  manifestPath: string;
  manifest: BatchManifest;
  failedRuns: number;
}

interface LoadedMethod {
  path: string;
  canonicalHash: string;
  sourceHash: string;
  key: string;
  config: MethodConfig;
  identity: ReturnType<typeof identifyMethod>;
}

export function runBatch(options: RunBatchOptions): RunBatchResult {
  if (options.resume && options.force) throw new Error("--resume and --force are mutually exclusive");
  const suiteManifestPath = resolve(options.suiteManifestPath);
  const outputDirectory = resolve(options.outputDirectory);
  const suiteBytes = readFileSync(suiteManifestPath, "utf8");
  const suite = parseSuiteManifest(JSON.parse(suiteBytes) as unknown);
  const methods = options.methodPaths.map(loadMethod).sort((a, b) => a.key.localeCompare(b.key));
  if (methods.length === 0) throw new Error("Batch requires at least one method configuration");
  const methodKeys = new Set(methods.map((method) => method.key));
  if (methodKeys.size !== methods.length) {
    throw new Error("Batch method configurations must have unique method keys");
  }
  const gitCommitSha = readGitCommit(dirname(suiteManifestPath));
  const scenarios = suite.scenarios
    .filter((scenario) => scenario.split === options.split)
    .sort((a, b) => a.path.localeCompare(b.path));
  if (scenarios.length === 0) throw new Error(`Suite contains no scenarios for split ${options.split}`);
  mkdirSync(outputDirectory, { recursive: true });

  const runs: BatchRunRecord[] = [];
  outer: for (const scenario of scenarios) {
    const scenarioPath = resolve(dirname(suiteManifestPath), scenario.path);
    const actualScenarioHash = sha256File(scenarioPath);
    const scenarioConfig = parseExperimentScenario(JSON.parse(readFileSync(scenarioPath, "utf8")) as unknown);
    for (const method of methods) {
      const engine = createExperimentEngine(method.config, method.identity);
      const provenance = engine.getProvenance(scenarioConfig, method.config);
      const runOutput = resolve(
        outputDirectory,
        scenario.split,
        scenario.family,
        scenario.variant,
        `seed-${scenario.seed}`,
        method.key,
      );
      const record: BatchRunRecord = {
        scenarioPath,
        methodPath: method.path,
        outputDirectory: runOutput,
        scenarioSha256: actualScenarioHash,
        methodIdentityVersion: method.identity.methodIdentityVersion,
        methodConfigCanonicalSha256: method.canonicalHash,
        methodConfigSourceSha256: method.sourceHash,
        methodConfigSha256: method.canonicalHash,
        methodId: method.config.id,
        methodKey: method.key,
        engineId: provenance.engineId,
        engineAdapterVersion: provenance.engineAdapterVersion,
        thirdPartyLockSha256: provenance.thirdPartyLockSha256,
        upstreamCommit: provenance.upstreamCommit,
        runnerSha256: provenance.runnerSha256,
        status: "failed",
        error: null,
      };
      try {
        if (actualScenarioHash !== scenario.sha256) {
          throw new Error(`Scenario hash does not match suite manifest: ${scenario.path}`);
        }
        if (
          options.resume &&
          completedRunMatches(
            runOutput,
            actualScenarioHash,
            method.canonicalHash,
            method.key,
            method.identity.methodIdentityVersion,
            provenance,
            gitCommitSha,
            options.allowCrossCommitResume ?? false,
          )
        ) {
          record.status = "skipped";
        } else {
          if (!options.resume && !options.force && completedArtifactsExist(runOutput)) {
            throw new Error(`Output exists; use --resume or --force: ${runOutput}`);
          }
          runExperiment({
            scenarioPath,
            methodPath: method.path,
            outputDirectory: runOutput,
            commandArguments: ["batch"],
          });
          record.status = "completed";
        }
      } catch (error) {
        record.status = "failed";
        record.error = error instanceof Error ? error.message : String(error);
      }
      runs.push(record);
      if (record.status === "failed" && options.failFast) break outer;
    }
  }

  const manifest: BatchManifest = {
    batchManifestVersion: BATCH_MANIFEST_VERSION,
    suiteManifestPath,
    suiteManifestSha256: sha256Bytes(suiteBytes),
    gitCommitSha,
    split: options.split,
    resume: options.resume ?? false,
    force: options.force ?? false,
    allowCrossCommitResume: options.allowCrossCommitResume ?? false,
    failFast: options.failFast ?? false,
    runs,
  };
  const manifestPath = resolve(outputDirectory, "batch-manifest.json");
  const temporaryPath = `${manifestPath}.tmp`;
  rmSync(temporaryPath, { force: true });
  writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  rmSync(manifestPath, { force: true });
  renameSync(temporaryPath, manifestPath);
  return {
    manifestPath,
    manifest,
    failedRuns: runs.filter((run) => run.status === "failed").length,
  };
}

function parseSuiteManifest(value: unknown): SuiteManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Suite manifest must be an object");
  }
  const manifest = value as Partial<SuiteManifest>;
  if (manifest.suiteManifestVersion !== 1 || !Array.isArray(manifest.scenarios)) {
    throw new Error("Unsupported or malformed suite manifest");
  }
  for (const [index, scenario] of manifest.scenarios.entries()) {
    if (
      typeof scenario.path !== "string" ||
      typeof scenario.sha256 !== "string" ||
      typeof scenario.split !== "string" ||
      typeof scenario.family !== "string" ||
      typeof scenario.variant !== "string" ||
      !Number.isSafeInteger(scenario.seed)
    ) {
      throw new Error(`Malformed suite manifest scenario at index ${index}`);
    }
  }
  return manifest as SuiteManifest;
}

function loadMethod(path: string): LoadedMethod {
  const absolutePath = resolve(path);
  const bytes = readFileSync(absolutePath, "utf8");
  const config = parseMethodConfig(JSON.parse(bytes) as unknown);
  const identity = identifyMethod(config, bytes);
  return {
    path: absolutePath,
    canonicalHash: identity.methodConfigCanonicalSha256,
    sourceHash: identity.methodConfigSourceSha256,
    key: identity.methodKey,
    config,
    identity,
  };
}

function completedArtifactsExist(outputDirectory: string): boolean {
  return ["manifest.json", "trajectory.jsonl", "summary.json", "run-metrics.json"].some((name) =>
    existsSync(resolve(outputDirectory, name)),
  );
}

function completedRunMatches(
  outputDirectory: string,
  scenarioHash: string,
  methodHash: string,
  methodKey: string,
  methodIdentityVersion: number,
  provenance: EngineProvenance,
  gitCommitSha: string | null,
  allowCrossCommit: boolean,
): boolean {
  const paths = ["manifest.json", "trajectory.jsonl", "summary.json", "run-metrics.json"].map((name) =>
    resolve(outputDirectory, name),
  );
  if (!paths.every(existsSync)) return false;
  try {
    const manifest = JSON.parse(readFileSync(paths[0], "utf8")) as ExperimentManifest;
    const summary = JSON.parse(readFileSync(paths[2], "utf8")) as ExperimentRunSummary;
    const metrics = JSON.parse(readFileSync(paths[3], "utf8")) as RunMetrics;
    const trajectory = readFileSync(paths[1], "utf8");
    for (const line of trajectory.split(/\r?\n/u).filter(Boolean)) JSON.parse(line) as unknown;
    return (
      manifest.scenarioSha256 === scenarioHash &&
      manifest.methodIdentityVersion === methodIdentityVersion &&
      manifest.methodConfigCanonicalSha256 === methodHash &&
      manifest.methodKey === methodKey &&
      manifest.engineId === provenance.engineId &&
      manifest.engineAdapterVersion === provenance.engineAdapterVersion &&
      manifest.thirdPartyLockSha256 === provenance.thirdPartyLockSha256 &&
      manifest.upstreamCommit === provenance.upstreamCommit &&
      manifest.runnerSha256 === provenance.runnerSha256 &&
      summary.methodKey === methodKey &&
      metrics.identity.methodKey === methodKey &&
      metrics.identity.methodIdentityVersion === methodIdentityVersion &&
      metrics.identity.methodConfigCanonicalSha256 === methodHash &&
      metrics.identity.engineId === provenance.engineId &&
      (allowCrossCommit || manifest.gitCommitSha === gitCommitSha)
    );
  } catch {
    return false;
  }
}

function readGitCommit(startDirectory: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: startDirectory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function parseArguments(arguments_: readonly string[]): RunBatchOptions {
  let suiteManifestPath: string | undefined;
  let methodPaths: string[] | undefined;
  let split: string | undefined;
  let outputDirectory: string | undefined;
  let resume = false;
  let force = false;
  let allowCrossCommitResume = false;
  let failFast = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (argument === "--suite" && value !== undefined) {
      suiteManifestPath = value;
      index += 1;
    } else if (argument === "--methods" && value !== undefined) {
      methodPaths = value.split(",").filter(Boolean);
      index += 1;
    } else if (argument === "--split" && value !== undefined) {
      split = value;
      index += 1;
    } else if (argument === "--out" && value !== undefined) {
      outputDirectory = value;
      index += 1;
    } else if (argument === "--resume") resume = true;
    else if (argument === "--force") force = true;
    else if (argument === "--allow-cross-commit-resume") allowCrossCommitResume = true;
    else if (argument === "--fail-fast") failFast = true;
    else throw new Error(`Unknown or incomplete argument: ${argument}`);
  }
  if (suiteManifestPath === undefined) throw new Error("Missing required --suite path");
  if (methodPaths === undefined) throw new Error("Missing required --methods list");
  if (split === undefined) throw new Error("Missing required --split");
  if (outputDirectory === undefined) throw new Error("Missing required --out directory");
  return {
    suiteManifestPath,
    methodPaths,
    split,
    outputDirectory,
    resume,
    force,
    allowCrossCommitResume,
    failFast,
  };
}

function main(): void {
  try {
    const result = runBatch(parseArguments(process.argv.slice(2)));
    const completed = result.manifest.runs.filter((run) => run.status === "completed").length;
    const skipped = result.manifest.runs.filter((run) => run.status === "skipped").length;
    console.log(`exp:batch completed=${completed} skipped=${skipped} failed=${result.failedRuns}`);
    if (result.failedRuns > 0) process.exitCode = 1;
  } catch (error) {
    console.error(`exp:batch failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) main();
