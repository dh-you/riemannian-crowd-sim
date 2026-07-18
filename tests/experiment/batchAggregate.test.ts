import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { aggregateBatch } from "../../experiments/cli/aggregate";
import { runBatch } from "../../experiments/cli/runBatch";
import { generateFreeSpaceScenario } from "../../experiments/generation/freeSpace";
import { generatePairwiseScenario } from "../../experiments/generation/pairwise";
import type { SuiteManifest } from "../../experiments/generation/suite";
import { sha256Bytes } from "../../experiments/protocol/hash";
import { identifyMethod } from "../../experiments/protocol/methodIdentity";
import { parseMethodConfig } from "../../experiments/protocol/methodConfig";
import { serializeExperimentScenario } from "../../experiments/protocol/schema";

const temporaryDirectories: string[] = [];
const methods = [
  resolve("experiments/methods/riemannian-default.json"),
  resolve("experiments/methods/goal-projection.json"),
];
const methodIdentities = methods.map(methodIdentityForPath);

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("sequential batch runner and aggregation", () => {
  it("schedules the complete Cartesian product at deterministic paths", () => {
    const fixture = createSuiteFixture();
    const outputDirectory = join(fixture.root, "batch");
    const result = runBatch({
      suiteManifestPath: fixture.manifestPath,
      methodPaths: methods,
      split: "smoke",
      outputDirectory,
    });
    expect(result.failedRuns).toBe(0);
    expect(result.manifest.runs).toHaveLength(4);
    expect(result.manifest.batchManifestVersion).toBe(2);
    expect(result.manifest.runs.every(({ status }) => status === "completed")).toBe(true);
    expect(result.manifest.runs.map(({ outputDirectory: path }) => path)).toEqual([
      resolve(outputDirectory, `smoke/free_space/single_agent/seed-0/${methodIdentities[0].methodKey}`),
      resolve(outputDirectory, `smoke/free_space/single_agent/seed-0/${methodIdentities[1].methodKey}`),
      resolve(outputDirectory, `smoke/pairwise/head_on/seed-1/${methodIdentities[0].methodKey}`),
      resolve(outputDirectory, `smoke/pairwise/head_on/seed-1/${methodIdentities[1].methodKey}`),
    ]);
  });

  it("resumes only matching parseable artifacts and reruns a stale method hash", () => {
    const fixture = createSuiteFixture();
    const outputDirectory = join(fixture.root, "batch");
    runBatch({
      suiteManifestPath: fixture.manifestPath,
      methodPaths: methods,
      split: "smoke",
      outputDirectory,
    });
    const matching = runBatch({
      suiteManifestPath: fixture.manifestPath,
      methodPaths: methods,
      split: "smoke",
      outputDirectory,
      resume: true,
    });
    expect(matching.manifest.runs.every(({ status }) => status === "skipped")).toBe(true);

    const staleManifestPath = resolve(
      outputDirectory,
      `smoke/free_space/single_agent/seed-0/${methodIdentities[1].methodKey}/manifest.json`,
    );
    const staleManifest = JSON.parse(readFileSync(staleManifestPath, "utf8")) as Record<string, unknown>;
    staleManifest.methodConfigSha256 = "stale";
    writeFileSync(staleManifestPath, `${JSON.stringify(staleManifest, null, 2)}\n`, "utf8");
    const resumed = runBatch({
      suiteManifestPath: fixture.manifestPath,
      methodPaths: methods,
      split: "smoke",
      outputDirectory,
      resume: true,
    });
    expect(resumed.manifest.runs.filter(({ status }) => status === "completed")).toHaveLength(1);
    expect(resumed.manifest.runs.filter(({ status }) => status === "skipped")).toHaveLength(3);
  });

  it("records stale scenario hashes as failures and exposes nonzero CLI semantics", () => {
    const fixture = createSuiteFixture();
    const manifest = JSON.parse(readFileSync(fixture.manifestPath, "utf8")) as SuiteManifest;
    manifest.scenarios[0].sha256 = "stale";
    writeFileSync(fixture.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const outputDirectory = join(fixture.root, "failed-batch");
    const result = runBatch({
      suiteManifestPath: fixture.manifestPath,
      methodPaths: methods,
      split: "smoke",
      outputDirectory,
    });
    expect(result.failedRuns).toBe(2);
    expect(result.manifest.runs.filter(({ status }) => status === "failed")).toHaveLength(2);
    expect(result.manifest.runs.filter(({ status }) => status === "completed")).toHaveLength(2);
    expect(result.manifest.runs.filter(({ status }) => status === "failed")[0].error).toMatch(/hash/u);

    const cli = spawnSync(
      process.execPath,
      [
        resolve("node_modules/tsx/dist/cli.mjs"),
        resolve("experiments/cli/runBatch.ts"),
        "--suite",
        fixture.manifestPath,
        "--methods",
        methods.join(","),
        "--split",
        "smoke",
        "--out",
        join(fixture.root, "cli-failed-batch"),
      ],
      { encoding: "utf8" },
    );
    expect(cli.status).toBe(1);
  });

  it("writes stable flat CSV, empty unavailable fields, and a separate failures file", () => {
    const fixture = createSuiteFixture();
    const outputDirectory = join(fixture.root, "batch");
    runBatch({
      suiteManifestPath: fixture.manifestPath,
      methodPaths: methods,
      split: "smoke",
      outputDirectory,
    });
    const aggregate = aggregateBatch({ inputDirectory: outputDirectory, outputDirectory: join(outputDirectory, "aggregate") });
    const metricsCsv = readFileSync(aggregate.runMetricsCsvPath, "utf8");
    const failuresCsv = readFileSync(aggregate.failuresCsvPath, "utf8");
    expect(aggregate.completedRows).toBe(4);
    expect(aggregate.failureRows).toBe(0);
    expect(metricsCsv.split("\n")[0]).toBe(
      "scenario_name,family,variant,split,seed,method_key,method_id,method_config_sha256,velocity_time_constant,alpha,sigma,lambda_r,lambda_t,agent_count,success_fraction,mean_normalized_travel_time,mean_path_efficiency,minimum_pre_correction_agent_clearance,minimum_pre_correction_wall_clearance,maximum_pre_correction_agent_penetration,maximum_post_correction_agent_penetration,maximum_pre_correction_wall_penetration,maximum_post_correction_wall_penetration,pre_correction_overlap_pair_seconds,post_correction_overlap_pair_seconds,correction_ratio,rms_acceleration,rms_jerk,throughput,pairwise_onset_time_agent_0,pairwise_ttc_agent_0,pairwise_onset_time_agent_1,pairwise_ttc_agent_1,pairwise_minimum_pre_correction_center_distance,pairwise_minimum_pre_correction_physical_clearance,pairwise_minimum_post_correction_center_distance,pairwise_minimum_post_correction_physical_clearance",
    );
    expect(metricsCsv).not.toMatch(/NaN|Infinity/u);
    const freeSpaceRows = metricsCsv.split("\n").filter((line) => line.includes(",free_space,"));
    expect(freeSpaceRows).toHaveLength(2);
    expect(freeSpaceRows.every((line) => line.endsWith(",,,,,,,,"))).toBe(true);
    expect(failuresCsv).toBe(
      "scenario_path,method_key,method_id,method_config_sha256,output_directory,error\n",
    );
  });

  it("keeps multiple configurations of one controller in distinct keyed outputs and CSV rows", () => {
    const fixture = createSuiteFixture();
    const alternateMethodPath = join(fixture.root, "riemannian-alternate.json");
    const alternate = JSON.parse(readFileSync(methods[0], "utf8")) as {
      parameters: { alpha: number };
    };
    alternate.parameters.alpha = 20;
    writeFileSync(alternateMethodPath, `${JSON.stringify(alternate, null, 2)}\n`, "utf8");
    const outputDirectory = join(fixture.root, "multi-config-batch");
    const batch = runBatch({
      suiteManifestPath: fixture.manifestPath,
      methodPaths: [methods[0], alternateMethodPath],
      split: "smoke",
      outputDirectory,
    });
    expect(batch.failedRuns).toBe(0);
    expect(new Set(batch.manifest.runs.map(({ methodKey }) => methodKey)).size).toBe(2);
    expect(new Set(batch.manifest.runs.map(({ outputDirectory: path }) => path)).size).toBe(4);
    expect(
      batch.manifest.runs.every(({ methodKey, methodConfigSha256 }) =>
        methodKey.endsWith(methodConfigSha256.slice(0, 12)),
      ),
    ).toBe(true);

    const aggregate = aggregateBatch({
      inputDirectory: outputDirectory,
      outputDirectory: join(outputDirectory, "aggregate"),
    });
    const lines = readFileSync(aggregate.runMetricsCsvPath, "utf8").trim().split("\n");
    const headers = lines[0].split(",");
    const alphaIndex = headers.indexOf("alpha");
    const methodKeyIndex = headers.indexOf("method_key");
    const rows = lines.slice(1).map((line) => line.split(","));
    expect(new Set(rows.map((row) => row[alphaIndex]))).toEqual(new Set(["10", "20"]));
    expect(new Set(rows.map((row) => row[methodKeyIndex])).size).toBe(2);
  });
});

function createSuiteFixture(): { root: string; manifestPath: string } {
  const root = mkdtempSync(join(tmpdir(), "riemannian-stage-b-batch-"));
  temporaryDirectories.push(root);
  const scenarios = [
    shortened(generateFreeSpaceScenario("smoke", 0)),
    shortened(generatePairwiseScenario("head_on", "smoke", 1)),
  ];
  const entries = scenarios.map((scenario) => {
    const relativePath = `scenarios/${scenario.family}-seed-${scenario.seed}.json`;
    const bytes = serializeExperimentScenario(scenario);
    const path = resolve(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes, "utf8");
    return {
      path: relativePath,
      seed: scenario.seed,
      family: scenario.family,
      variant: scenario.variant,
      split: scenario.split,
      agentCount: scenario.agents.length,
      sha256: sha256Bytes(bytes),
    };
  });
  const manifest: SuiteManifest = {
    suiteManifestVersion: 1,
    suiteVersion: 1,
    suiteId: "test_fixture",
    generatorVersion: "protocol_v1",
    suiteDefinitionSha256: "fixture",
    gitCommitSha: null,
    scenarios: entries,
  };
  const manifestPath = resolve(root, "suite-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { root, manifestPath };
}

function shortened<T extends { simulation: { dt: number; horizonSeconds: number } }>(scenario: T): T {
  scenario.simulation.horizonSeconds = scenario.simulation.dt * 2;
  return scenario;
}

function methodIdentityForPath(path: string) {
  const bytes = readFileSync(path, "utf8");
  return identifyMethod(parseMethodConfig(JSON.parse(bytes) as unknown), bytes);
}
