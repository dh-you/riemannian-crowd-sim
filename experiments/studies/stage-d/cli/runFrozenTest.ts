import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runExperiment } from "../../../cli/runExperiment";
import type { RunMetrics } from "../../../metrics/types";
import { sha256File } from "../../../protocol/hash";
import {
  FREEZE_MANIFEST_PATH,
  type FreezeManifest,
  type FrozenMethodRecord,
} from "./freezeConfigurations";
import {
  RESULTS_ROOT,
  currentGitHead,
  git,
  readJson,
  verifyPreregisteredPlan,
  writeJson,
} from "../studyPaths";
import type { StudyScenarioEntry } from "../scenarios";

interface FrozenAssignment {
  assignmentIndex: number;
  scenario: StudyScenarioEntry;
  method: FrozenMethodRecord;
  outputDirectory: string;
}

interface CompletedAssignment {
  assignmentIndex: number;
  scenarioId: string;
  scenarioSha256: string;
  methodId: string;
  methodKey: string;
  outputDirectory: string;
  manifestPath: string;
  metricsPath: string;
}

interface FailedAssignment {
  assignmentIndex: number;
  scenarioId: string;
  methodId: string;
  methodKey: string;
  error: string;
}

export interface FrozenTestShardManifest {
  frozenTestShardManifestVersion: 1;
  status: "IN_PROGRESS" | "PASS" | "FAIL";
  freezeManifestSha256: string;
  freezeCommit: string;
  shardIndex: number;
  shardCount: number;
  jobs: number;
  resume: boolean;
  failFast: boolean;
  assignmentCount: number;
  assignments: Array<{
    assignmentIndex: number;
    scenarioId: string;
    scenarioSha256: string;
    methodId: string;
    methodKey: string;
  }>;
  completed: CompletedAssignment[];
  failures: FailedAssignment[];
}

interface TestOptions {
  shardIndex: number;
  shardCount: number;
  jobs: number;
  resume: boolean;
  failFast: boolean;
}

export function assertFrozenExecutionState(): FreezeManifest {
  verifyPreregisteredPlan();
  const status = git(["status", "--short"]);
  if (status !== "") throw new Error("Frozen test execution requires a clean tracked worktree");
  const head = currentGitHead();
  const subject = git(["show", "-s", "--format=%s", "HEAD"]);
  if (subject !== "Freeze Stage D method configurations") {
    throw new Error("Frozen test execution requires the exact freeze commit at HEAD");
  }
  const freeze = readJson<FreezeManifest>(FREEZE_MANIFEST_PATH);
  if (freeze.freezeManifestVersion !== 1 || freeze.status !== "FROZEN") {
    throw new Error("Freeze manifest is absent or malformed");
  }
  const parent = git(["rev-parse", "HEAD^"]);
  if (parent !== freeze.repositoryShaBeforeFreeze) {
    throw new Error("Freeze commit parent does not match the recorded pre-freeze repository SHA");
  }
  for (const method of freeze.frozenMethods) {
    if (sha256File(method.path) !== method.methodConfigSourceSha256) {
      throw new Error(`Frozen method source hash mismatch: ${method.methodId}`);
    }
  }
  for (const scenario of freeze.testScenarios) {
    if (sha256File(scenario.path) !== scenario.sha256) {
      throw new Error(`Frozen test scenario hash mismatch: ${scenario.scenarioId}`);
    }
  }
  if (freeze.expectedTestRunCount !== freeze.testScenarios.length * freeze.frozenMethods.length) {
    throw new Error("Freeze manifest Cartesian count is inconsistent");
  }
  if (!/^[a-f0-9]{40}$/u.test(head)) throw new Error("Invalid freeze commit identity");
  return freeze;
}

export async function runFrozenTest(options: TestOptions): Promise<FrozenTestShardManifest> {
  const freeze = assertFrozenExecutionState();
  validateOptions(options);
  const allAssignments = buildAssignments(freeze);
  const assignments = allAssignments.filter(({ assignmentIndex }) =>
    assignmentIndex % options.shardCount === options.shardIndex);
  const shardPath = resolve(
    RESULTS_ROOT,
    "test/shards",
    `shard-${options.shardIndex}-of-${options.shardCount}.json`,
  );
  let manifest: FrozenTestShardManifest = existsSync(shardPath)
    ? readJson<FrozenTestShardManifest>(shardPath)
    : {
        frozenTestShardManifestVersion: 1,
        status: "IN_PROGRESS",
        freezeManifestSha256: sha256File(FREEZE_MANIFEST_PATH),
        freezeCommit: currentGitHead(),
        shardIndex: options.shardIndex,
        shardCount: options.shardCount,
        jobs: options.jobs,
        resume: options.resume,
        failFast: options.failFast,
        assignmentCount: assignments.length,
        assignments: assignments.map(({ assignmentIndex, scenario, method }) => ({
          assignmentIndex,
          scenarioId: scenario.scenarioId,
          scenarioSha256: scenario.sha256,
          methodId: method.methodId,
          methodKey: method.methodKey,
        })),
        completed: [],
        failures: [],
      };
  verifyShardResume(manifest, options, assignments.length);
  if (manifest.status === "PASS") {
    if (!options.resume) throw new Error("Frozen test shard already exists; use --resume to verify it");
    for (const assignment of assignments) validateExistingAssignment(assignment);
    return manifest;
  }
  if (manifest.failures.length > 0) {
    throw new Error("Refusing to resume a shard with recorded failures");
  }
  const completedIndices = new Set(manifest.completed.map(({ assignmentIndex }) => assignmentIndex));
  const pending = assignments.filter((assignment) => !completedIndices.has(assignment.assignmentIndex));
  if (!options.resume && manifest.completed.length > 0) {
    throw new Error("Partial shard output exists; explicit --resume is required");
  }
  for (const assignment of assignments.filter(({ assignmentIndex }) => completedIndices.has(assignmentIndex))) {
    validateExistingAssignment(assignment);
  }
  let nextIndex = 0;
  let stop = false;
  const worker = async (): Promise<void> => {
    while (!stop) {
      const assignment = pending[nextIndex];
      nextIndex += 1;
      if (assignment === undefined) return;
      try {
        await executeAssignment(assignment, options.jobs === 1);
        const completed = validateExistingAssignment(assignment);
        manifest.completed.push(completed);
        manifest.completed.sort((first, second) => first.assignmentIndex - second.assignmentIndex);
      } catch (error) {
        manifest.failures.push({
          assignmentIndex: assignment.assignmentIndex,
          scenarioId: assignment.scenario.scenarioId,
          methodId: assignment.method.methodId,
          methodKey: assignment.method.methodKey,
          error: error instanceof Error ? error.message : String(error),
        });
        if (options.failFast) stop = true;
      }
      writeJson(shardPath, manifest);
    }
  };
  await Promise.all(Array.from({ length: options.jobs }, worker));
  manifest.status = manifest.failures.length === 0 && manifest.completed.length === assignments.length
    ? "PASS"
    : "FAIL";
  writeJson(shardPath, manifest);
  if (manifest.status !== "PASS") {
    throw new Error(`Frozen test shard failed ${manifest.failures.length} assignments`);
  }
  return manifest;
}

function buildAssignments(freeze: FreezeManifest): FrozenAssignment[] {
  const scenarios = [...freeze.testScenarios].sort((first, second) =>
    first.scenarioId.localeCompare(second.scenarioId));
  const methods = [...freeze.frozenMethods].sort((first, second) =>
    first.methodId.localeCompare(second.methodId));
  let assignmentIndex = 0;
  const assignments: FrozenAssignment[] = [];
  for (const scenario of scenarios) {
    for (const method of methods) {
      assignments.push({
        assignmentIndex,
        scenario,
        method,
        outputDirectory: resolve(RESULTS_ROOT, "test/runs", scenario.scenarioId, method.methodKey),
      });
      assignmentIndex += 1;
    }
  }
  if (assignments.length !== freeze.expectedTestRunCount) {
    throw new Error("Frozen assignment count differs from freeze manifest");
  }
  return assignments;
}

async function executeAssignment(assignment: FrozenAssignment, direct: boolean): Promise<void> {
  const existingManifest = resolve(assignment.outputDirectory, "manifest.json");
  if (existsSync(existingManifest)) {
    throw new Error(`Output already exists for assignment ${assignment.assignmentIndex}`);
  }
  if (direct) {
    const interval = recordingInterval(assignment);
    runExperiment({
      scenarioPath: assignment.scenario.path,
      methodPath: assignment.method.path,
      outputDirectory: assignment.outputDirectory,
      recordingInterval: interval,
      commandArguments: ["study:d:test", String(assignment.assignmentIndex)],
    });
    return;
  }
  const tsxCli = resolve("node_modules/tsx/dist/cli.mjs");
  const runner = resolve("experiments/cli/runExperiment.ts");
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [
      tsxCli,
      runner,
      "--scenario",
      assignment.scenario.path,
      "--method",
      assignment.method.path,
      "--out",
      assignment.outputDirectory,
      "--record-every",
      String(recordingInterval(assignment)),
    ], {
      cwd: resolve("."),
      env: {
        ...process.env,
        OMP_NUM_THREADS: "1",
        OPENBLAS_NUM_THREADS: "1",
        MKL_NUM_THREADS: "1",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`experiment child exited ${String(code)}: ${stderr.slice(-2000)}`));
    });
  });
}

/** Preregistered representative trajectories: lowest test seed for two shown pairwise variants. */
function recordingInterval(assignment: FrozenAssignment): number {
  return assignment.scenario.family === "pairwise"
    && assignment.scenario.seed === 1000
    && ["head_on", "crossing"].includes(assignment.scenario.variant)
    ? 1
    : 1_000_000_000;
}

function validateExistingAssignment(assignment: FrozenAssignment): CompletedAssignment {
  const manifestPath = resolve(assignment.outputDirectory, "manifest.json");
  const metricsPath = resolve(assignment.outputDirectory, "run-metrics.json");
  if (!existsSync(manifestPath) || !existsSync(metricsPath)) {
    throw new Error(`Assignment ${assignment.assignmentIndex} has incomplete output`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    scenarioSha256: string;
    methodKey: string;
    methodConfigCanonicalSha256: string;
    methodConfigSourceSha256: string;
    engineId: string;
    gitCommitSha: string | null;
  };
  const metrics = JSON.parse(readFileSync(metricsPath, "utf8")) as RunMetrics;
  if (manifest.scenarioSha256 !== assignment.scenario.sha256
    || manifest.methodKey !== assignment.method.methodKey
    || manifest.methodConfigCanonicalSha256 !== assignment.method.methodConfigCanonicalSha256
    || manifest.methodConfigSourceSha256 !== assignment.method.methodConfigSourceSha256
    || manifest.engineId !== assignment.method.engineId
    || manifest.gitCommitSha !== currentGitHead()
    || metrics.identity.methodKey !== assignment.method.methodKey
    || containsNonFinite(metrics)) {
    throw new Error(`Assignment ${assignment.assignmentIndex} provenance validation failed`);
  }
  return {
    assignmentIndex: assignment.assignmentIndex,
    scenarioId: assignment.scenario.scenarioId,
    scenarioSha256: assignment.scenario.sha256,
    methodId: assignment.method.methodId,
    methodKey: assignment.method.methodKey,
    outputDirectory: assignment.outputDirectory,
    manifestPath,
    metricsPath,
  };
}

function verifyShardResume(
  manifest: FrozenTestShardManifest,
  options: TestOptions,
  assignmentCount: number,
): void {
  if (manifest.frozenTestShardManifestVersion !== 1
    || manifest.freezeManifestSha256 !== sha256File(FREEZE_MANIFEST_PATH)
    || manifest.freezeCommit !== currentGitHead()
    || manifest.shardIndex !== options.shardIndex
    || manifest.shardCount !== options.shardCount
    || manifest.assignmentCount !== assignmentCount) {
    throw new Error("Frozen test shard resume identity mismatch");
  }
}

function validateOptions(options: TestOptions): void {
  for (const [name, value] of Object.entries({
    shardIndex: options.shardIndex,
    shardCount: options.shardCount,
    jobs: options.jobs,
  })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative integer`);
  }
  if (options.shardCount < 1 || options.jobs < 1 || options.shardIndex >= options.shardCount) {
    throw new Error("Invalid shard or job configuration");
  }
}

function parseArguments(arguments_: readonly string[]): TestOptions {
  const options: TestOptions = { shardIndex: 0, shardCount: 1, jobs: 1, resume: false, failFast: false };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--resume") options.resume = true;
    else if (argument === "--fail-fast") options.failFast = true;
    else if (["--shard-index", "--shard-count", "--jobs"].includes(argument)) {
      const value = arguments_[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a value`);
      const key = argument === "--shard-index" ? "shardIndex"
        : argument === "--shard-count" ? "shardCount" : "jobs";
      options[key] = Number(value);
      index += 1;
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function containsNonFinite(value: unknown): boolean {
  if (typeof value === "number") return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some(containsNonFinite);
  if (value !== null && typeof value === "object") return Object.values(value).some(containsNonFinite);
  return false;
}

async function main(): Promise<void> {
  try {
    const manifest = await runFrozenTest(parseArguments(process.argv.slice(2)));
    console.log(`study:d:test PASS shard ${manifest.shardIndex}/${manifest.shardCount}: ${manifest.completed.length} assignments`);
  } catch (error) {
    console.error(`study:d:test failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) void main();
