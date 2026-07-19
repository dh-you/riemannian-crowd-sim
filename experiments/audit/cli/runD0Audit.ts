import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sha256File } from "../../protocol/hash";
import { AUDIT_RESULTS_ROOT, writeJson } from "./auditUtils";

const BASE_COMMIT = "8143c06faee3bcbb6a5bce217b5d97b222fb0876";

export const READY_AFTER_HUMAN_VISUAL_REVIEW = "READY AFTER HUMAN VISUAL REVIEW" as const;
export const BLOCKED_INCOMPLETE_REPRODUCTION = "BLOCKED — INCOMPLETE REPRODUCTION" as const;
export const NOT_READY_AUDIT_MISMATCH = "NOT READY — AUDIT MISMATCH" as const;

export type D0ReadinessDecision =
  | typeof READY_AFTER_HUMAN_VISUAL_REVIEW
  | typeof BLOCKED_INCOMPLETE_REPRODUCTION
  | typeof NOT_READY_AUDIT_MISMATCH;

export const REQUIRED_D0_COMMAND_IDS = [
  "production-tests",
  "baseline-verification",
  "baseline-tests",
  "metric-audit",
  "riemannian-audit",
  "gold-audit",
  "fairness-audit",
  "visual-audit",
] as const;

export interface CommandResult {
  id: string;
  command: string;
  status: "PASS" | "FAIL";
  exitCode: number;
  logPath: string;
  repositoryCommit: string;
}

export interface D0ReadinessInputs {
  commandResults: readonly CommandResult[];
  metricsStatus: string | null;
  riemannianStatus: string | null;
  goldStatus: string | null;
  fairnessStatus: string | null;
  cleanClone: { status?: string; auditedCommit?: string } | null;
  currentHead: string;
  protectedScientificFileChanges: readonly string[];
}

function runCommand(id: string, arguments_: readonly string[]): CommandResult {
  const repositoryCommit = git(["rev-parse", "HEAD"]);
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
  return { id, command: `npm ${arguments_.join(" ")}`, status, exitCode: result.status ?? -1, logPath, repositoryCommit };
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

export function determineD0Readiness(inputs: D0ReadinessInputs): D0ReadinessDecision {
  const machineMismatch = [
    inputs.metricsStatus,
    inputs.riemannianStatus,
    inputs.goldStatus,
    inputs.fairnessStatus,
  ].some((status) => status === "FAIL");
  if (machineMismatch) return NOT_READY_AUDIT_MISMATCH;

  const requiredCommandsPass = REQUIRED_D0_COMMAND_IDS.every((id) => {
    const matches = inputs.commandResults.filter((result) => result.id === id);
    return matches.length === 1 && matches[0].status === "PASS" &&
      matches[0].repositoryCommit === inputs.currentHead;
  });
  const auditReportsPass = inputs.metricsStatus === "PASS" &&
    inputs.riemannianStatus === "PASS" && inputs.goldStatus === "PASS" &&
    inputs.fairnessStatus === "PASS";
  const cleanCloneIsCurrent = inputs.cleanClone?.status === "PASS" &&
    inputs.cleanClone.auditedCommit === inputs.currentHead;
  const protectedScienceIsUnchanged = inputs.protectedScientificFileChanges.length === 0;

  return requiredCommandsPass && auditReportsPass && cleanCloneIsCurrent &&
    protectedScienceIsUnchanged
    ? READY_AFTER_HUMAN_VISUAL_REVIEW
    : BLOCKED_INCOMPLETE_REPRODUCTION;
}

export function d0CliExitCode(decision: D0ReadinessDecision): 0 | 1 {
  return decision === READY_AFTER_HUMAN_VISUAL_REVIEW ? 0 : 1;
}

export function writeFinalAuditReport(commandResults: readonly CommandResult[] = []): { readinessDecision: D0ReadinessDecision; reportPath: string } {
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
  const cleanClone = readOptional(cleanClonePath) as { status?: string; auditedCommit?: string } | null;
  const currentHead = git(["rev-parse", "HEAD"]);
  const protectedPaths = [
    "src/core",
    "experiments/engines/ScientificCoreEngine.ts",
    "experiments/engines/OrcaRvo2Engine.ts",
    "experiments/engines/PySocialForceEngine.ts",
    "experiments/engines/externalProtocol.ts",
    "experiments/protocol/schema.ts",
    "experiments/protocol/methodConfig.ts",
    "experiments/generation",
    "experiments/baselines/orca",
    "experiments/baselines/social_force",
    "experiments/baselines/patches",
    "experiments/methods",
  ];
  const protectedChanges = git(["diff", "--name-only", BASE_COMMIT, "--", ...protectedPaths]).split(/\r?\n/u).filter(Boolean);
  const readinessDecision = determineD0Readiness({
    commandResults,
    metricsStatus: metrics?.status ?? null,
    riemannianStatus: riemannian?.status ?? null,
    goldStatus: gold?.status ?? null,
    fairnessStatus: fairness?.status ?? null,
    cleanClone,
    currentHead,
    protectedScientificFileChanges: protectedChanges,
  });
  const requiredCommandsPass = REQUIRED_D0_COMMAND_IDS.every((id) => {
    const matches = commandResults.filter((result) => result.id === id);
    return matches.length === 1 && matches[0].status === "PASS" &&
      matches[0].repositoryCommit === currentHead;
  });
  const cleanCloneIsCurrent = cleanClone?.status === "PASS" && cleanClone.auditedCommit === currentHead;
  const buildManifestPath = resolve("experiments", "third_party", "build", "build-manifest.json");
  const lockPath = resolve("experiments", "baselines", "third-party-lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { dependencies: { id: string; commit: string; license: string }[] };
  const checks = [
    { id: "required-current-commands", description: "All required commands passed at the current commit", status: requiredCommandsPass ? "PASS" : "BLOCKED", evidence: commandResults, maximumNumericalDiscrepancy: null },
    { id: "production-tests", description: "Existing production tests", status: currentCommandStatus(commandResults, "production-tests", currentHead), evidence: commandResults.find((entry) => entry.id === "production-tests")?.logPath ?? null, maximumNumericalDiscrepancy: null },
    { id: "synthetic-and-real-metrics", description: "Independent metric agreement", status: metrics?.status ?? "BLOCKED", evidence: metricsPath, maximumNumericalDiscrepancy: metrics?.maximumAbsoluteDifference ?? null },
    { id: "riemannian-equations", description: "Independent Riemannian equation agreement", status: riemannian?.status ?? "BLOCKED", evidence: riemannianPath, maximumNumericalDiscrepancy: Math.max(riemannian?.maximumMetricEntryError ?? 0, riemannian?.maximumTargetVelocityError ?? 0, riemannian?.maximumInvariantError ?? 0) },
    { id: "scenario-fairness", description: "Four-method scenario/provenance agreement", status: fairness?.status ?? "BLOCKED", evidence: fairnessPath, maximumNumericalDiscrepancy: null },
    { id: "orca-provenance", description: "Pinned ORCA provenance and native semantics", status: fairness?.status ?? "BLOCKED", evidence: fairnessPath, maximumNumericalDiscrepancy: null },
    { id: "pysocialforce-provenance", description: "Pinned PySocialForce provenance and native semantics", status: fairness?.status ?? "BLOCKED", evidence: fairnessPath, maximumNumericalDiscrepancy: null },
    { id: "gold-expectations", description: "Human-readable gold expectations", status: gold?.status ?? "BLOCKED", evidence: goldPath, maximumNumericalDiscrepancy: null },
    { id: "clean-clone", description: "Clean-clone reproduction of the current commit", status: cleanCloneIsCurrent ? "PASS" : "BLOCKED", evidence: { path: cleanClonePath, auditedCommit: cleanClone?.auditedCommit ?? null, expectedCommit: currentHead }, maximumNumericalDiscrepancy: null },
    { id: "visual-review", description: "Human visual inspection", status: visual?.status ?? "PENDING HUMAN REVIEW", evidence: resolve(AUDIT_RESULTS_ROOT, "visual-checklist.md"), maximumNumericalDiscrepancy: null },
    { id: "protected-production", description: "Protected scientific implementation remained unchanged", status: protectedChanges.length === 0 ? "PASS" : "FAIL", evidence: protectedChanges, maximumNumericalDiscrepancy: null },
  ];
  const report = {
    stageD0AuditReportVersion: 3,
    readinessDecision,
    environment: {
      repositoryCommit: currentHead,
      d0BaseCommit: BASE_COMMIT,
      branch: git(["branch", "--show-current"]),
      operatingSystem: platform(),
      architecture: arch(),
      nodeVersion: process.version,
      pythonVersion: pythonVersion(),
      baselineBuildManifestSha256: existsSync(buildManifestPath) ? sha256File(buildManifestPath) : null,
      thirdPartyLockSha256: sha256File(lockPath),
      upstream: lock.dependencies.map((entry) => ({ id: entry.id, commit: entry.commit, license: entry.license })),
      auditToolCommit: currentHead,
    },
    checks,
    commandResults,
    discrepancies: gold?.firstFailure === undefined || gold.firstFailure === null ? [] : [gold.firstFailure],
    protectedScientificFileChanges: protectedChanges,
    resolvedFindings: [
      "Stage C.2 defines realized path from each emitted step's post-correction position minus that same step's before position, so engine representation conversion is not counted as travel.",
      "Stage C.2 restores the locked PySocialForce checkout after upstream tests and removes generated tracked, untracked, and ignored artifacts before applying the locked patch.",
    ],
    unresolvedQuestions: [],
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
    `Status: **${cleanCloneIsCurrent ? "PASS" : "BLOCKED"}**. Audited commit: \`${cleanClone?.auditedCommit ?? "missing"}\`; current commit: \`${currentHead}\`. A passing report requires a no-local clone of the current commit, fresh dependency/bootstrap/build steps, and four-method byte/identity comparison.`,
    "",
    "## Discrepancies, resolved findings, and unresolved questions",
    "",
    ...(report.discrepancies.length === 0
      ? ["No machine-checkable mismatch was recorded."]
      : ["The first machine-checkable mismatch is:", "", "```json", JSON.stringify(report.discrepancies[0], null, 2), "```"]),
    "",
    "Resolved D0 findings:",
    "",
    ...report.resolvedFindings.map((finding) => `- ${finding}`),
    "",
    "No unresolved semantic question is recorded by Stage C.2; any future failed check still fails closed through the decision logic above.",
    "",
    "## Visual review status",
    "",
    `Visual packet status: **${visual?.status ?? "PENDING HUMAN REVIEW"}**. Automated generation is not human approval.`,
    "",
    "## Stage D readiness",
    "",
    readinessDecision === READY_AFTER_HUMAN_VISUAL_REVIEW
      ? "All machine checks and clean-clone reproduction passed. Stage D remains gated on human visual review."
      : "Stage D must not begin while this readiness decision remains non-ready.",
    "",
  ].join("\n");
  writeFileSync(resolve(AUDIT_RESULTS_ROOT, "report.md"), markdown, "utf8");
  return { readinessDecision, reportPath };
}

function currentCommandStatus(
  commandResults: readonly CommandResult[],
  id: string,
  currentHead: string,
): "PASS" | "FAIL" | "BLOCKED" {
  const matches = commandResults.filter((result) => result.id === id);
  if (matches.length !== 1 || matches[0].repositoryCommit !== currentHead) return "BLOCKED";
  return matches[0].status;
}

export function runD0Audit(): { readinessDecision: D0ReadinessDecision; reportPath: string } {
  const commandResults = [
    runCommand("production-tests", ["test"]),
    runCommand("baseline-verification", ["run", "baselines:verify"]),
    runCommand("baseline-tests", ["run", "test:baselines"]),
    runCommand("metric-audit", ["run", "audit:metrics"]),
    runCommand("riemannian-audit", ["run", "audit:riemannian"]),
    runCommand("gold-audit", ["run", "audit:gold"]),
    runCommand("fairness-audit", ["run", "audit:fairness"]),
    runCommand("visual-audit", ["run", "audit:visuals"]),
  ];
  return writeFinalAuditReport(commandResults);
}

function main(): void {
  try {
    const result = runD0Audit();
    console.log(`audit:d0 completed with decision: ${result.readinessDecision}`);
    process.exitCode = d0CliExitCode(result.readinessDecision);
  } catch (error) {
    console.error(`audit:d0 failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) main();
