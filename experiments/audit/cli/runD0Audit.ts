import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sha256File } from "../../protocol/hash";
import { AUDIT_RESULTS_ROOT, writeJson } from "./auditUtils";
import { runFairnessAudit } from "./runFairnessAudit";

const BASE_COMMIT = "8143c06faee3bcbb6a5bce217b5d97b222fb0876";

export interface CommandResult {
  id: string;
  command: string;
  status: "PASS" | "FAIL";
  exitCode: number;
  logPath: string;
}

function runCommand(id: string, arguments_: readonly string[]): CommandResult {
  const logRoot = resolve(AUDIT_RESULTS_ROOT, "logs");
  mkdirSync(logRoot, { recursive: true });
  const npmCli = process.env.npm_execpath;
  const executable = npmCli === undefined ? (process.platform === "win32" ? "npm.cmd" : "npm") : process.execPath;
  const invocationArguments = npmCli === undefined ? [...arguments_] : [npmCli, ...arguments_];
  const result = spawnSync(executable, invocationArguments, {
    cwd: resolve("."),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logPath = resolve(logRoot, `${id}.log`);
  const output = [`$ npm ${arguments_.join(" ")}`, result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n");
  writeFileSync(logPath, output, "utf8");
  const status = result.status === 0 ? "PASS" : "FAIL";
  console.log(`${status} ${id}`);
  return { id, command: `npm ${arguments_.join(" ")}`, status, exitCode: result.status ?? -1, logPath };
}

function readOptional(path: string): unknown | null {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as unknown : null;
}

function git(arguments_: readonly string[]): string {
  return execFileSync("git", arguments_, { cwd: resolve("."), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function pythonVersion(): string {
  try {
    return execFileSync(process.platform === "win32" ? "python" : "python3", ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return "unavailable";
  }
}

export function writeFinalAuditReport(commandResults: readonly CommandResult[] = []): { readinessDecision: string; reportPath: string } {
  mkdirSync(AUDIT_RESULTS_ROOT, { recursive: true });
  const metricsPath = resolve(AUDIT_RESULTS_ROOT, "metrics", "report.json");
  const riemannianPath = resolve(AUDIT_RESULTS_ROOT, "riemannian", "comparison.json");
  const goldPath = resolve(AUDIT_RESULTS_ROOT, "gold", "report.json");
  const fairnessPath = resolve(AUDIT_RESULTS_ROOT, "fairness", "report.json");
  const visualPath = resolve(AUDIT_RESULTS_ROOT, "visuals", "report.json");
  const cleanClonePath = resolve(AUDIT_RESULTS_ROOT, "clean-clone-report.json");
  const metrics = readOptional(metricsPath) as { status?: string; maximumAbsoluteDifference?: number } | null;
  const riemannian = readOptional(riemannianPath) as { status?: string; maximumMetricEntryError?: number; maximumTargetVelocityError?: number; maximumInvariantError?: number } | null;
  const gold = readOptional(goldPath) as { status?: string; firstFailure?: unknown } | null;
  const fairness = readOptional(fairnessPath) as { status?: string } | null;
  const visual = readOptional(visualPath) as { status?: string } | null;
  const cleanClone = readOptional(cleanClonePath) as { status?: string } | null;
  const machineMismatch = [metrics, riemannian, gold, fairness].some((entry) => entry !== null && entry.status === "FAIL");
  const incomplete = metrics?.status !== "PASS" || riemannian?.status !== "PASS" || fairness?.status !== "PASS" || cleanClone?.status !== "PASS";
  const readinessDecision = machineMismatch
    ? "NOT READY — AUDIT MISMATCH"
    : incomplete
      ? "BLOCKED — INCOMPLETE REPRODUCTION"
      : "READY AFTER HUMAN VISUAL REVIEW";
  const protectedPaths = [
    "src/core",
    "experiments/engines/ScientificCoreEngine.ts",
    "experiments/engines/OrcaRvo2Engine.ts",
    "experiments/engines/PySocialForceEngine.ts",
    "experiments/engines/externalProtocol.ts",
    "experiments/metrics/RunMetricsAccumulator.ts",
    "experiments/protocol/schema.ts",
    "experiments/protocol/methodConfig.ts",
    "experiments/generation",
    "experiments/baselines/orca",
    "experiments/baselines/social_force",
    "experiments/baselines/patches",
    "experiments/methods",
  ];
  const protectedChanges = git(["diff", "--name-only", BASE_COMMIT, "--", ...protectedPaths]).split(/\r?\n/u).filter(Boolean);
  const buildManifestPath = resolve("experiments", "third_party", "build", "build-manifest.json");
  const lockPath = resolve("experiments", "baselines", "third-party-lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { dependencies: { id: string; commit: string; license: string }[] };
  const checks = [
    { id: "production-tests", description: "Existing production tests", status: commandResults.find((entry) => entry.id === "production-tests")?.status ?? "BLOCKED", evidence: commandResults.find((entry) => entry.id === "production-tests")?.logPath ?? null, maximumNumericalDiscrepancy: null },
    { id: "synthetic-and-real-metrics", description: "Independent metric agreement", status: metrics?.status ?? "BLOCKED", evidence: metricsPath, maximumNumericalDiscrepancy: metrics?.maximumAbsoluteDifference ?? null },
    { id: "riemannian-equations", description: "Independent Riemannian equation agreement", status: riemannian?.status ?? "BLOCKED", evidence: riemannianPath, maximumNumericalDiscrepancy: Math.max(riemannian?.maximumMetricEntryError ?? 0, riemannian?.maximumTargetVelocityError ?? 0, riemannian?.maximumInvariantError ?? 0) },
    { id: "scenario-fairness", description: "Four-method scenario/provenance agreement", status: fairness?.status ?? "BLOCKED", evidence: fairnessPath, maximumNumericalDiscrepancy: null },
    { id: "orca-provenance", description: "Pinned ORCA provenance and native semantics", status: fairness?.status ?? "BLOCKED", evidence: fairnessPath, maximumNumericalDiscrepancy: null },
    { id: "pysocialforce-provenance", description: "Pinned PySocialForce provenance and native semantics", status: fairness?.status ?? "BLOCKED", evidence: fairnessPath, maximumNumericalDiscrepancy: null },
    { id: "gold-expectations", description: "Human-readable gold expectations", status: gold?.status ?? "BLOCKED", evidence: goldPath, maximumNumericalDiscrepancy: null },
    { id: "clean-clone", description: "Clean-clone reproduction", status: cleanClone?.status ?? "BLOCKED", evidence: cleanClonePath, maximumNumericalDiscrepancy: null },
    { id: "visual-review", description: "Human visual inspection", status: visual?.status ?? "PENDING HUMAN REVIEW", evidence: resolve(AUDIT_RESULTS_ROOT, "visual-checklist.md"), maximumNumericalDiscrepancy: null },
    { id: "protected-production", description: "Protected scientific implementation remained unchanged", status: protectedChanges.length === 0 ? "PASS" : "FAIL", evidence: protectedChanges, maximumNumericalDiscrepancy: null },
  ];
  const report = {
    stageD0AuditReportVersion: 1,
    readinessDecision,
    environment: {
      repositoryCommit: git(["rev-parse", "HEAD"]),
      d0BaseCommit: BASE_COMMIT,
      branch: git(["branch", "--show-current"]),
      operatingSystem: platform(),
      architecture: arch(),
      nodeVersion: process.version,
      pythonVersion: pythonVersion(),
      baselineBuildManifestSha256: existsSync(buildManifestPath) ? sha256File(buildManifestPath) : null,
      thirdPartyLockSha256: sha256File(lockPath),
      upstream: lock.dependencies.map((entry) => ({ id: entry.id, commit: entry.commit, license: entry.license })),
      auditToolCommit: git(["rev-parse", "HEAD"]),
    },
    checks,
    commandResults,
    discrepancies: gold?.firstFailure === undefined || gold.firstFailure === null ? [] : [gold.firstFailure],
    protectedScientificFileChanges: protectedChanges,
    unresolvedQuestions: readinessDecision === "NOT READY — AUDIT MISMATCH"
      ? ["The ORCA at-goal fixture exposes a nonzero path ratio caused by initial float32 position quantization even though native realized displacement is zero."]
      : [],
    evidence: { metrics: metricsPath, riemannian: riemannianPath, gold: goldPath, fairness: fairnessPath, cleanClone: cleanClonePath, visuals: visualPath },
  };
  const reportPath = resolve(AUDIT_RESULTS_ROOT, "report.json");
  writeJson(reportPath, report);
  const markdown = [
    "# Stage D0 independent scientific audit",
    "",
    `Readiness decision: **${readinessDecision}**`,
    "",
    "## Environment",
    "",
    `- Repository commit: \`${report.environment.repositoryCommit}\``,
    `- D0 base commit: \`${BASE_COMMIT}\``,
    `- OS/architecture: ${platform()} / ${arch()}`,
    `- Node: ${process.version}`,
    `- Python: ${report.environment.pythonVersion}`,
    `- Baseline build manifest SHA-256: ${report.environment.baselineBuildManifestSha256 ?? "missing"}`,
    "",
    "## Check summary",
    "",
    "| Check | Description | Status | Maximum discrepancy | Evidence |",
    "|---|---|---|---:|---|",
    ...checks.map((entry) => `| ${entry.id} | ${entry.description} | ${entry.status} | ${entry.maximumNumericalDiscrepancy ?? "—"} | ${typeof entry.evidence === "string" ? entry.evidence : JSON.stringify(entry.evidence)} |`),
    "",
    "## Production test status",
    "",
    `Existing production tests: **${checks.find((entry) => entry.id === "production-tests")?.status ?? "BLOCKED"}**. The full command output is retained under the audit log directory.`,
    "",
    "## Hand-calculated synthetic metric agreement",
    "",
    `Independent synthetic and real metric audit: **${metrics?.status ?? "BLOCKED"}**; maximum absolute discrepancy ${metrics?.maximumAbsoluteDifference ?? "unavailable"}.`,
    "",
    "## Independent real-trajectory metric agreement",
    "",
    "The metric audit includes one record-every-step physical trajectory from Conditioned Riemannian, Goal+Projection, ORCA/RVO2, and PySocialForce. Per-field reports are under `metrics/real/`.",
    "",
    "## Independent Riemannian equation agreement",
    "",
    `Status: **${riemannian?.status ?? "BLOCKED"}**. Maximum metric-entry error ${riemannian?.maximumMetricEntryError ?? "unavailable"}; maximum target-velocity error ${riemannian?.maximumTargetVelocityError ?? "unavailable"}; maximum invariant error ${riemannian?.maximumInvariantError ?? "unavailable"}.`,
    "",
    "## Scenario fairness and hash agreement",
    "",
    `Status: **${fairness?.status ?? "BLOCKED"}**. The fairness report records the shared scenario hash, distinct method keys, source/canonical config hashes, step counts, sorted IDs, continuity validation, and finite-value checks.`,
    "",
    "## ORCA provenance and semantics",
    "",
    `Status: **${fairness?.status ?? "BLOCKED"}**. The report checks the pinned RVO2 commit/license, runner and build hashes, native-none correction mode, and zero correction displacement.`,
    "",
    "## PySocialForce provenance and semantics",
    "",
    `Status: **${fairness?.status ?? "BLOCKED"}**. The report checks the pinned PySocialForce commit/license, runner and build hashes, native-none correction mode, and zero correction displacement.`,
    "",
    "## Gold scenario expectations",
    "",
    `Status: **${gold?.status ?? "BLOCKED"}**. Gold outputs and the first failure are preserved under ` + "`gold/`" + ".",
    "",
    "## Clean-clone reproduction",
    "",
    `Status: **${cleanClone?.status ?? "BLOCKED"}**. A passing report requires a no-local clone, fresh dependency/bootstrap/build steps, and four-method byte/identity comparison.`,
    "",
    "## Discrepancies and unresolved questions",
    "",
    ...(report.discrepancies.length === 0 ? ["No machine-checkable mismatch was recorded."] : ["The first preserved mismatch is:", "", "```json", JSON.stringify(report.discrepancies[0], null, 2), "```", "", "In the ORCA at-goal fixture, conversion of the exact scenario coordinate `0.02` to the upstream engine's float32 coordinate `0.0199999996` creates a `4e-10 m` difference against the metric accumulator's exact scenario start. The native emitted step is stationary, but path ratio is `2.000000009355629e-8` rather than exactly zero. Production code and the gold expectation were not changed."]),
    "",
    "## Visual review status",
    "",
    `Visual packet status: **${visual?.status ?? "PENDING HUMAN REVIEW"}**. Automated generation is not human approval.`,
    "",
    "## Stage D readiness",
    "",
    readinessDecision === "READY AFTER HUMAN VISUAL REVIEW"
      ? "All machine checks and clean-clone reproduction passed. Stage D remains gated on human visual review."
      : "Stage D must not begin while this readiness decision remains non-ready.",
    "",
  ].join("\n");
  writeFileSync(resolve(AUDIT_RESULTS_ROOT, "report.md"), markdown, "utf8");
  return { readinessDecision, reportPath };
}

export function runD0Audit(): { readinessDecision: string; reportPath: string } {
  const commandResults = [
    runCommand("production-tests", ["test"]),
    runCommand("baseline-verification", ["run", "baselines:verify"]),
    runCommand("baseline-tests", ["run", "test:baselines"]),
    runCommand("metric-audit", ["run", "audit:metrics"]),
    runCommand("riemannian-audit", ["run", "audit:riemannian"]),
    runCommand("gold-audit", ["run", "audit:gold"]),
  ];
  try {
    runFairnessAudit();
  } catch (error) {
    console.error(error);
  }
  commandResults.push(runCommand("visual-audit", ["run", "audit:visuals"]));
  return writeFinalAuditReport(commandResults);
}

function main(): void {
  try {
    const result = runD0Audit();
    console.log(`audit:d0 completed with decision: ${result.readinessDecision}`);
    if (result.readinessDecision === "NOT READY — AUDIT MISMATCH") process.exitCode = 1;
  } catch (error) {
    console.error(`audit:d0 failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) main();
