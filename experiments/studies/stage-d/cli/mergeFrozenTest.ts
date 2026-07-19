import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sha256File } from "../../../protocol/hash";
import { FREEZE_MANIFEST_PATH, type FreezeManifest } from "./freezeConfigurations";
import type { FrozenTestShardManifest } from "./runFrozenTest";
import { RESULTS_ROOT, currentGitHead, readJson, writeJson } from "../studyPaths";

interface MergedTestManifest {
  mergedTestManifestVersion: 1;
  status: "PASS";
  freezeManifestSha256: string;
  freezeCommit: string;
  shardCount: number;
  expectedRunCount: number;
  completedRunCount: number;
  scenarioCount: number;
  methodCount: number;
  runs: FrozenTestShardManifest["completed"];
}

export function mergeFrozenTest(shardCount: number): MergedTestManifest {
  if (!Number.isSafeInteger(shardCount) || shardCount < 1) throw new Error("shardCount must be positive");
  const freeze = readJson<FreezeManifest>(FREEZE_MANIFEST_PATH);
  const freezeHash = sha256File(FREEZE_MANIFEST_PATH);
  const shards = Array.from({ length: shardCount }, (_, shardIndex) => {
    const path = resolve(RESULTS_ROOT, "test/shards", `shard-${shardIndex}-of-${shardCount}.json`);
    if (!existsSync(path)) throw new Error(`Missing frozen test shard: ${path}`);
    const shard = readJson<FrozenTestShardManifest>(path);
    if (shard.status !== "PASS" || shard.freezeManifestSha256 !== freezeHash
      || shard.freezeCommit !== currentGitHead() || shard.shardIndex !== shardIndex
      || shard.shardCount !== shardCount || shard.failures.length !== 0) {
      throw new Error(`Invalid frozen test shard ${shardIndex}`);
    }
    return shard;
  });
  const runs = shards.flatMap(({ completed }) => completed)
    .sort((first, second) => first.assignmentIndex - second.assignmentIndex);
  if (runs.length !== freeze.expectedTestRunCount) {
    throw new Error(`Missing frozen test runs: expected ${freeze.expectedTestRunCount}, received ${runs.length}`);
  }
  const indices = new Set(runs.map(({ assignmentIndex }) => assignmentIndex));
  const pairs = new Set(runs.map(({ scenarioId, methodKey }) => `${scenarioId}\0${methodKey}`));
  if (indices.size !== runs.length || pairs.size !== runs.length) {
    throw new Error("Frozen test merge found duplicate assignments");
  }
  for (let index = 0; index < runs.length; index += 1) {
    if (runs[index].assignmentIndex !== index) throw new Error(`Missing assignment index ${index}`);
    if (!existsSync(runs[index].manifestPath) || !existsSync(runs[index].metricsPath)) {
      throw new Error(`Merged run artifact is missing: ${index}`);
    }
    const manifest = JSON.parse(readFileSync(runs[index].manifestPath, "utf8")) as {
      scenarioSha256: string;
      methodKey: string;
    };
    if (manifest.scenarioSha256 !== runs[index].scenarioSha256
      || manifest.methodKey !== runs[index].methodKey) {
      throw new Error(`Merged run provenance mismatch: ${index}`);
    }
  }
  const merged: MergedTestManifest = {
    mergedTestManifestVersion: 1,
    status: "PASS",
    freezeManifestSha256: freezeHash,
    freezeCommit: currentGitHead(),
    shardCount,
    expectedRunCount: freeze.expectedTestRunCount,
    completedRunCount: runs.length,
    scenarioCount: new Set(runs.map(({ scenarioId }) => scenarioId)).size,
    methodCount: new Set(runs.map(({ methodId }) => methodId)).size,
    runs,
  };
  if (merged.scenarioCount !== 290 || merged.methodCount !== 4) {
    throw new Error("Merged frozen test does not contain the preregistered 290 x 4 Cartesian product");
  }
  writeJson(resolve(RESULTS_ROOT, "test/merged-test-manifest.json"), merged);
  return merged;
}

function main(): void {
  try {
    const index = process.argv.indexOf("--shard-count");
    const count = index < 0 ? 1 : Number(process.argv[index + 1]);
    const merged = mergeFrozenTest(count);
    console.log(`study:d:merge PASS: ${merged.completedRunCount} unique runs`);
  } catch (error) {
    console.error(`study:d:merge failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) main();
