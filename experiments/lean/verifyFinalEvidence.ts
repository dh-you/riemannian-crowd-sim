import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { validateEngineStepRecord, type EngineStepRecord } from "../engines/engineStep";
import { sha256Bytes } from "../protocol/hash";
import {
  assignmentIdentity,
  buildAssignments,
  loadStudy,
  runKey,
  validateWorkerRecord,
  type RunRecord,
} from "./run";
import { writeJson } from "./audit/runUtils";

const EXACT_TOLERANCE = 1e-8;
const ORCA_TOLERANCE = 1e-6;
const ACTIVE_METHODS = ["riemannian", "goal", "orca", "jupedsim-sfm"] as const;
const RETAINED_METHOD_IDS = [
  "conditioned_riemannian_metric_v1",
  "euclidean_goal_steering_v1",
  "orca_rvo2_v1",
] as const;
const PAPER_METRICS = new Set([
  "successFraction",
  "normalizedCompletionTime",
  "preCorrectionOverlapExposure",
  "maximumPhysicalPenetration",
  "rmsAcceleration",
]);

interface AuditManifest {
  scenarioName: string;
  scenarioSha256: string;
  expectedStepCount: number;
  actualStepCount: number;
  methodId: string;
  methodConfigCanonicalSha256: string;
  methodConfigSourceSha256: string;
  engineId: string;
  engineSpecificProvenance?: Record<string, unknown>;
  engineArtifactDiagnostics?: Record<string, unknown>;
  implementationCommit?: string;
}

interface JuPedSimStabilityDiagnostic {
  diagnosticVersion: number;
  experimentDt: number;
  nativeJuPedSimDt: number;
  nativeSubstepsPerExperimentStep: number;
  nativeIterationCount: number;
  protocolTargetResolutionCount: number;
  targetAssignmentCount: number;
  targetHeldAcrossNativeSubsteps: boolean;
  peakNativeSpeedMetersPerSecond: { value: number };
  peakNativeAccelerationMetersPerSecondSquared: { value: number };
  minimumArtificialOuterBoundaryClearanceMeters: number;
}

interface EquivalenceRow {
  scenarioName: string;
  methodId: string;
  tolerance: number;
  steps: number;
  newTrajectorySha256: string;
  retainedTrajectorySha256: string;
  newMetricsSha256: string;
  retainedMetricsSha256: string;
}

export function compareScientificValues(
  actual: unknown,
  expected: unknown,
  path: string,
  tolerance: number,
): void {
  if (typeof actual === "number" || typeof expected === "number") {
    if (
      typeof actual !== "number"
      || typeof expected !== "number"
      || !Number.isFinite(actual)
      || !Number.isFinite(expected)
      || Math.abs(actual - expected) > tolerance * Math.max(1, Math.abs(actual), Math.abs(expected))
    ) {
      throw new Error(`${path}: numeric divergence ${String(actual)} != ${String(expected)} (tolerance ${tolerance})`);
    }
    return;
  }
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) {
      throw new Error(`${path}: array shape divergence`);
    }
    for (let index = 0; index < actual.length; index += 1) {
      compareScientificValues(actual[index], expected[index], `${path}[${index}]`, tolerance);
    }
    return;
  }
  if (
    actual !== null
    && expected !== null
    && typeof actual === "object"
    && typeof expected === "object"
  ) {
    const actualObject = actual as Record<string, unknown>;
    const expectedObject = expected as Record<string, unknown>;
    const actualKeys = Object.keys(actualObject).sort();
    const expectedKeys = Object.keys(expectedObject).sort();
    if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
      throw new Error(`${path}: object-key divergence ${actualKeys.join(",")} != ${expectedKeys.join(",")}`);
    }
    for (const key of actualKeys) {
      compareScientificValues(actualObject[key], expectedObject[key], `${path}.${key}`, tolerance);
    }
    return;
  }
  if (!Object.is(actual, expected)) {
    throw new Error(`${path}: value divergence ${String(actual)} != ${String(expected)}`);
  }
}

export async function verifyRetainedEquivalence(
  canonicalAuditRootSource: string,
): Promise<string> {
  const study = loadStudy();
  const newAuditRoot = resolve(study.outputs.auditRoot);
  const canonicalAuditRoot = resolve(canonicalAuditRootSource);
  const newRuns = auditRuns(newAuditRoot);
  const canonicalRuns = auditRuns(canonicalAuditRoot);
  const rows: EquivalenceRow[] = [];
  for (const [key, newRun] of [...newRuns.entries()].sort()) {
    if (!RETAINED_METHOD_IDS.includes(newRun.manifest.methodId as typeof RETAINED_METHOD_IDS[number])) {
      continue;
    }
    const retained = canonicalRuns.get(key);
    if (retained === undefined) throw new Error(`Retained audit is missing ${key}`);
    if (newRun.manifest.scenarioSha256 !== retained.manifest.scenarioSha256) {
      throw new Error(`${key}: scenario hash divergence`);
    }
    const tolerance = newRun.manifest.methodId === "orca_rvo2_v1"
      ? ORCA_TOLERANCE
      : EXACT_TOLERANCE;
    const newTrajectory = trajectoryPath(newRun.directory);
    const retainedTrajectory = trajectoryPath(retained.directory);
    const steps = await compareJsonLines(newTrajectory, retainedTrajectory, key, tolerance);
    const newMetricsPath = resolve(newRun.directory, "run-metrics.json");
    const retainedMetricsPath = resolve(retained.directory, "run-metrics.json");
    compareScientificValues(
      JSON.parse(readFileSync(newMetricsPath, "utf8")) as unknown,
      JSON.parse(readFileSync(retainedMetricsPath, "utf8")) as unknown,
      `${key}.metrics`,
      tolerance,
    );
    rows.push({
      scenarioName: newRun.manifest.scenarioName,
      methodId: newRun.manifest.methodId,
      tolerance,
      steps,
      newTrajectorySha256: await sha256FileStreaming(newTrajectory),
      retainedTrajectorySha256: await sha256FileStreaming(retainedTrajectory),
      newMetricsSha256: await sha256FileStreaming(newMetricsPath),
      retainedMetricsSha256: await sha256FileStreaming(retainedMetricsPath),
    });
  }
  if (rows.length !== 15) {
    throw new Error(`Expected 15 retained-method equivalence checks, received ${rows.length}`);
  }
  const reportPath = resolve(study.outputs.root, "retained-equivalence.json");
  writeJson(reportPath, {
    equivalenceReportVersion: 1,
    status: "PASS",
    canonicalAuditRoot,
    newAuditRoot,
    comparisons: rows,
  });
  return reportPath;
}

export async function verifyFinalEvidence(): Promise<string> {
  const study = loadStudy();
  const outputRoot = resolve(study.outputs.root);
  const rawPath = resolve(study.outputs.raw);
  requireFrozenStudy(study);
  const records = readRunRecords(rawPath);
  const phases = ["audit", "test", "ablation", "runtime"] as const;
  const assignments = phases.flatMap((phase) => buildAssignments(study, phase));
  const expected = new Map(assignments.map((assignment) => [runKey(assignment), assignment]));
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (expected.size !== 416 || records.size !== expected.size) {
    throw new Error(`Expected 416 unique total records, received expected=${expected.size}, actual=${records.size}`);
  }
  for (const [key, assignment] of expected) {
    const record = records.get(key);
    if (record === undefined) throw new Error(`Missing assignment ${key}`);
    if (record.status !== "PASS") throw new Error(`Failed assignment ${key}: ${String(record.error)}`);
    if (JSON.stringify(record.assignmentIdentity) !== JSON.stringify(assignmentIdentity(assignment))) {
      throw new Error(`Assignment identity mismatch for ${key}`);
    }
    if (record.implementationCommit !== commit) {
      throw new Error(`${key}: implementation commit differs from frozen HEAD`);
    }
    if (record.method === "jupedsim-sfm") {
      const diagnostic = requireJuPedSimStabilityDiagnostic(
        record.engineArtifactDiagnostics,
        key,
      );
      if (
        diagnostic.nativeIterationCount * Number(record.agentCount)
        !== 2 * diagnostic.protocolTargetResolutionCount
      ) {
        throw new Error(`${key}: JuPedSim native iteration/target-resolution counts disagree`);
      }
    } else if (record.engineArtifactDiagnostics !== undefined) {
      throw new Error(`${key}: non-JuPedSim run contains JuPedSim artifact diagnostics`);
    }
  }
  for (const key of records.keys()) {
    if (!expected.has(key)) throw new Error(`Unexpected assignment ${key}`);
  }
  if ([...records.values()].some((record) =>
    record.method === "social-force"
    || JSON.stringify(record.assignmentIdentity).includes("pysocialforce"))) {
    throw new Error("Final evidence contains a PySocialForce assignment");
  }

  const phaseCounts = countBy([...records.values()], (record) => record.phase);
  requireCount(phaseCounts, "audit", 28);
  requireCount(phaseCounts, "test", 280);
  requireCount(phaseCounts, "ablation", 60);
  requireCount(phaseCounts, "runtime", 48);
  const headlineCounts = countBy(
    [...records.values()].filter((record) => record.phase === "test"),
    (record) => record.method,
  );
  for (const method of ACTIVE_METHODS) requireCount(headlineCounts, method, 70);
  const runtime = [...records.values()].filter((record) => record.phase === "runtime");
  if (runtime.filter((record) => record.warmup === true).length !== 12) {
    throw new Error("Runtime evidence must contain 12 warmups");
  }
  if (runtime.filter((record) => record.warmup === false).length !== 36) {
    throw new Error("Runtime evidence must contain 36 measured runs");
  }
  for (const method of ACTIVE_METHODS) {
    if (runtime.filter((record) => record.method === method).length !== 12) {
      throw new Error(`Runtime evidence must contain 12 ${method} runs`);
    }
  }

  const visualRecords = [...records.values()].filter((record) =>
    record.phase === "audit" && typeof record.artifactDirectory === "string");
  if (visualRecords.length !== 20) throw new Error("Final audit must contain 20 visual artifacts");
  const manifests = auditRuns(resolve(study.outputs.auditRoot));
  if (manifests.size !== 20) throw new Error(`Expected 20 audit manifests, received ${manifests.size}`);
  for (const { directory, manifest } of manifests.values()) {
    if (manifest.actualStepCount !== manifest.expectedStepCount) {
      throw new Error(`${directory}: audit step-count mismatch`);
    }
    if (manifest.implementationCommit !== commit) {
      throw new Error(`${directory}: audit manifest implementation commit mismatch`);
    }
    const scenarioPath = resolve(study.outputs.auditRoot, "visuals", "scenarios", `${manifest.scenarioName}.json`);
    if (sha256Bytes(readFileSync(scenarioPath)) !== manifest.scenarioSha256) {
      throw new Error(`${directory}: scenario artifact hash mismatch`);
    }
    for (const hash of [
      manifest.scenarioSha256,
      manifest.methodConfigCanonicalSha256,
      manifest.methodConfigSourceSha256,
    ]) {
      if (!/^[a-f0-9]{64}$/u.test(hash)) throw new Error(`${directory}: malformed manifest hash`);
    }
    for (const name of [
      "audit-manifest.json",
      "engine-steps.jsonl",
      "engine-steps-full.jsonl",
      "run-metrics.json",
      "summary.json",
    ]) {
      if (!existsSync(resolve(directory, name))) throw new Error(`${directory}: missing ${name}`);
    }
    if (manifest.methodId === "social_force_jupedsim_v1") {
      const provenance = manifest.engineSpecificProvenance ?? {};
      if (
        provenance.jupedsimVersion !== "1.4.2"
        || provenance.correctionMode !== "native_none"
        || provenance.directSteering !== true
        || provenance.experimentDt !== 1 / 60
        || provenance.nativeJuPedSimDt !== 1 / 120
        || provenance.nativeSubstepsPerExperimentStep !== 2
      ) {
        throw new Error(`${directory}: JuPedSim provenance mismatch`);
      }
      const diagnostic = requireJuPedSimStabilityDiagnostic(
        manifest.engineArtifactDiagnostics,
        directory,
      );
      if (diagnostic.nativeIterationCount !== manifest.expectedStepCount * 2) {
        throw new Error(`${directory}: JuPedSim audit native iteration count mismatch`);
      }
    } else if (manifest.engineArtifactDiagnostics !== undefined) {
      throw new Error(`${directory}: non-JuPedSim audit contains JuPedSim artifact diagnostics`);
    }
  }

  const gatePath = resolve(study.humanReviewGate);
  if (!existsSync(gatePath) || readFileSync(gatePath, "utf8").trim().length === 0) {
    throw new Error("Human review gate is missing or empty");
  }
  const equivalencePath = resolve(outputRoot, "retained-equivalence.json");
  const equivalence = JSON.parse(readFileSync(equivalencePath, "utf8")) as { status?: unknown };
  if (equivalence.status !== "PASS") throw new Error("Retained equivalence report is not PASS");
  const sampledViewer = resolve(study.outputs.auditRoot, "viewer", "index.html");
  const fullRateViewer = resolve(study.outputs.auditRoot, "viewer-full-rate", "index.html");
  for (const path of [sampledViewer, fullRateViewer, resolve(study.outputs.summary)]) {
    if (!existsSync(path)) throw new Error(`Missing final output ${path}`);
  }
  verifyPaperSummary(resolve(outputRoot, "paper-facing-summary.csv"));

  const residualWork = walkFiles(resolve(outputRoot, "work"));
  if (residualWork.length > 0) throw new Error("Final work directory contains residual files");
  const excluded = new Set(["artifact-hashes.json", "final-verification.json"]);
  const artifactFiles = walkFiles(outputRoot)
    .filter((path) => !excluded.has(basename(path)))
    .sort();
  const artifactRows = [];
  for (const path of artifactFiles) {
    artifactRows.push({
      path: relative(outputRoot, path).replaceAll("\\", "/"),
      bytes: statSync(path).size,
      sha256: await sha256FileStreaming(path),
    });
  }
  const hashManifestPath = resolve(outputRoot, "artifact-hashes.json");
  writeJson(hashManifestPath, {
    artifactHashManifestVersion: 1,
    files: artifactRows,
  });
  for (const artifact of artifactRows) {
    const actual = await sha256FileStreaming(resolve(outputRoot, artifact.path));
    if (actual !== artifact.sha256) throw new Error(`Artifact changed during verification: ${artifact.path}`);
  }
  const reportPath = resolve(outputRoot, "final-verification.json");
  writeJson(reportPath, {
    finalVerificationVersion: 1,
    status: "PASS",
    frozenImplementationCommit: commit,
    counts: {
      total: records.size,
      audit: 28,
      auditVisual: 20,
      headline: 280,
      ablation: 60,
      runtime: 48,
      runtimeWarmups: 12,
      runtimeMeasured: 36,
      headlinePerMethod: Object.fromEntries(headlineCounts),
    },
    noDuplicates: true,
    noMissingAssignments: true,
    noFailedRuns: true,
    noNonfiniteValues: true,
    noPySocialForceAssignments: true,
    jupedsimIntegration: {
      packageDefaults: true,
      experimentDt: 1 / 60,
      nativeJuPedSimDt: 1 / 120,
      nativeSubstepsPerExperimentStep: 2,
      paperMetricsUseOuterStepRecords: true,
      runtimeIncludesAllNativeSubsteps: true,
    },
    retainedEquivalence: equivalencePath,
    artifactHashManifest: hashManifestPath,
    artifactHashManifestSha256: await sha256FileStreaming(hashManifestPath),
    artifactCount: artifactRows.length,
    sampledViewer,
    fullRateViewer,
    summary: resolve(study.outputs.summary),
    paperFacingSummary: resolve(outputRoot, "paper-facing-summary.csv"),
  });
  return reportPath;
}

function requireJuPedSimStabilityDiagnostic(
  value: unknown,
  label: string,
): JuPedSimStabilityDiagnostic {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}: missing JuPedSim stability diagnostics`);
  }
  const diagnostic = (value as Record<string, unknown>).numericalStability;
  if (diagnostic === null || typeof diagnostic !== "object" || Array.isArray(diagnostic)) {
    throw new Error(`${label}: missing JuPedSim numerical-stability diagnostic`);
  }
  const typed = diagnostic as Partial<JuPedSimStabilityDiagnostic>;
  if (
    typed.diagnosticVersion !== 1
    || typed.experimentDt !== 1 / 60
    || typed.nativeJuPedSimDt !== 1 / 120
    || typed.nativeSubstepsPerExperimentStep !== 2
    || !Number.isSafeInteger(typed.nativeIterationCount)
    || (typed.nativeIterationCount ?? 0) <= 0
    || !Number.isSafeInteger(typed.protocolTargetResolutionCount)
    || (typed.protocolTargetResolutionCount ?? 0) <= 0
    || typed.targetAssignmentCount !== typed.protocolTargetResolutionCount
    || typed.targetHeldAcrossNativeSubsteps !== true
    || !finiteNonnegativeDiagnostic(typed.peakNativeSpeedMetersPerSecond)
    || !finiteNonnegativeDiagnostic(typed.peakNativeAccelerationMetersPerSecondSquared)
    || typeof typed.minimumArtificialOuterBoundaryClearanceMeters !== "number"
    || !Number.isFinite(typed.minimumArtificialOuterBoundaryClearanceMeters)
    || typed.minimumArtificialOuterBoundaryClearanceMeters <= 0
  ) {
    throw new Error(`${label}: malformed JuPedSim numerical-stability diagnostic`);
  }
  return typed as JuPedSimStabilityDiagnostic;
}

function finiteNonnegativeDiagnostic(value: unknown): boolean {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof (value as { value?: unknown }).value === "number"
    && Number.isFinite((value as { value: number }).value)
    && (value as { value: number }).value >= 0;
}

function requireFrozenStudy(study: ReturnType<typeof loadStudy>): void {
  compareScientificValues(study.methods.riemannian, {
    methodConfigVersion: 1,
    id: "conditioned_riemannian_metric_v1",
    velocityTimeConstant: 0.04,
    parameters: { alpha: 20, sigma: 1.5, lambdaR: 20, lambdaT: 1 },
  }, "study.riemannian", 0);
  compareScientificValues(study.methods["jupedsim-sfm"], {
    methodConfigVersion: 2,
    id: "social_force_jupedsim_v1",
    engine: "jupedsim_sfm_engine_v1",
    parameters: {
      bodyForce: 120000,
      friction: 240000,
      mass: 80,
      reactionTime: 0.5,
      agentScale: 2000,
      obstacleScale: 2000,
      forceDistance: 0.08,
    },
  }, "study.jupedsim-sfm", 0);
  if (JSON.stringify(Object.keys(study.methods)) !== JSON.stringify(ACTIVE_METHODS)) {
    throw new Error("Final study method keys differ from the frozen four-method set");
  }
}

function readRunRecords(path: string): Map<string, RunRecord> {
  const records = new Map<string, RunRecord>();
  for (const line of readFileSync(path, "utf8").split(/\r?\n/u).filter(Boolean)) {
    const record = validateWorkerRecord(JSON.parse(line) as unknown);
    if (records.has(record.key)) throw new Error(`Duplicate run record ${record.key}`);
    records.set(record.key, record);
  }
  return records;
}

function auditRuns(root: string): Map<string, { directory: string; manifest: AuditManifest }> {
  const result = new Map<string, { directory: string; manifest: AuditManifest }>();
  for (const path of findNamedFiles(resolve(root, "visuals", "runs"), "audit-manifest.json")) {
    const manifest = JSON.parse(readFileSync(path, "utf8")) as AuditManifest;
    const key = `${manifest.scenarioName}::${manifest.methodId}`;
    if (result.has(key)) throw new Error(`Duplicate audit manifest ${key}`);
    result.set(key, { directory: resolve(path, ".."), manifest });
  }
  return result;
}

function trajectoryPath(directory: string): string {
  const full = resolve(directory, "engine-steps-full.jsonl");
  return existsSync(full) ? full : resolve(directory, "engine-steps.jsonl");
}

async function compareJsonLines(
  actualPath: string,
  expectedPath: string,
  label: string,
  tolerance: number,
): Promise<number> {
  const actual = jsonLines(actualPath)[Symbol.asyncIterator]();
  const expected = jsonLines(expectedPath)[Symbol.asyncIterator]();
  let count = 0;
  while (true) {
    const [actualLine, expectedLine] = await Promise.all([actual.next(), expected.next()]);
    if (actualLine.done || expectedLine.done) {
      if (actualLine.done !== expectedLine.done) throw new Error(`${label}: trajectory length divergence at line ${count + 1}`);
      break;
    }
    validateEngineStepRecord(actualLine.value as EngineStepRecord);
    validateEngineStepRecord(expectedLine.value as EngineStepRecord);
    compareScientificValues(actualLine.value, expectedLine.value, `${label}.trajectory[${count}]`, tolerance);
    count += 1;
  }
  return count;
}

async function* jsonLines(path: string): AsyncGenerator<unknown> {
  const input = createReadStream(path, { encoding: "utf8" });
  const reader = createInterface({ input, crlfDelay: Infinity });
  for await (const line of reader) {
    if (line.trim().length > 0) yield JSON.parse(line) as unknown;
  }
}

function findNamedFiles(directory: string, name: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? findNamedFiles(path, name) : entry.name === name ? [path] : [];
  }).sort();
}

function walkFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? walkFiles(path) : [path];
  });
}

async function sha256FileStreaming(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function countBy<T>(values: readonly T[], key: (value: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const selected = key(value);
    counts.set(selected, (counts.get(selected) ?? 0) + 1);
  }
  return counts;
}

function requireCount(counts: ReadonlyMap<string, number>, key: string, expected: number): void {
  const actual = counts.get(key) ?? 0;
  if (actual !== expected) throw new Error(`Expected ${expected} ${key} records, received ${actual}`);
}

function verifyPaperSummary(path: string): void {
  const lines = readFileSync(path, "utf8").trim().split(/\r?\n/u);
  const expectedHeader = "row_type,scenario_type,metric,method,comparator,n,total_runs,failures,median,q1,q3,unit,difference_definition";
  if (lines[0] !== expectedHeader) throw new Error("Paper-facing summary columns changed");
  if (lines.length !== 101) throw new Error(`Paper-facing summary must contain 100 rows, received ${lines.length - 1}`);
  for (const line of lines.slice(1)) {
    const columns = line.split(",");
    if (columns[0] !== "estimate" || !PAPER_METRICS.has(columns[2])) {
      throw new Error("Paper-facing summary contains a non-headline metric or row type");
    }
  }
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a path`);
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--equivalence")) {
    const canonical = option(args, "--canonical-audit");
    if (canonical === undefined) throw new Error("--equivalence requires --canonical-audit");
    console.log(`retained equivalence: PASS at ${await verifyRetainedEquivalence(canonical)}`);
    return;
  }
  if (args.includes("--final")) {
    console.log(`final evidence verification: PASS at ${await verifyFinalEvidence()}`);
    return;
  }
  throw new Error("Use --equivalence --canonical-audit <path> or --final");
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  main().catch((error) => {
    console.error(`lean evidence verification failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
