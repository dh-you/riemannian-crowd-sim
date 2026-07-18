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
import { serializeExperimentScenario } from "../../experiments/protocol/schema";

const temporaryDirectories: string[] = [];
const methods = [
  resolve("experiments/methods/riemannian-default.json"),
  resolve("experiments/methods/goal-projection.json"),
];

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
    expect(result.manifest.runs.every(({ status }) => status === "completed")).toBe(true);
    expect(result.manifest.runs.map(({ outputDirectory: path }) => path)).toEqual([
      resolve(outputDirectory, "smoke/free_space/single_agent/seed-0/conditioned_riemannian_metric_v1"),
      resolve(outputDirectory, "smoke/free_space/single_agent/seed-0/euclidean_goal_steering_v1"),
      resolve(outputDirectory, "smoke/pairwise/head_on/seed-1/conditioned_riemannian_metric_v1"),
      resolve(outputDirectory, "smoke/pairwise/head_on/seed-1/euclidean_goal_steering_v1"),
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
      "smoke/free_space/single_agent/seed-0/euclidean_goal_steering_v1/manifest.json",
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
      "scenario_name,family,variant,split,seed,method_id,agent_count,success_fraction,mean_normalized_travel_time,mean_path_efficiency,minimum_pre_correction_clearance,pre_correction_overlap_pair_seconds,post_correction_overlap_pair_seconds,correction_ratio,rms_acceleration,rms_jerk,throughput,pairwise_onset_time_agent_0,pairwise_ttc_agent_0,pairwise_onset_time_agent_1,pairwise_ttc_agent_1,pairwise_minimum_center_clearance,pairwise_minimum_physical_clearance",
    );
    expect(metricsCsv).not.toMatch(/NaN|Infinity/u);
    const freeSpaceRows = metricsCsv.split("\n").filter((line) => line.includes(",free_space,"));
    expect(freeSpaceRows).toHaveLength(2);
    expect(freeSpaceRows.every((line) => line.endsWith(",,,,,,"))).toBe(true);
    expect(failuresCsv).toBe("scenario_path,method_id,output_directory,error\n");
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
