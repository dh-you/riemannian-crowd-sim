import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { EngineStepRecord } from "../../engines/engineStep";
import { validateEngineStepRecord } from "../../engines/engineStep";
import type { RunMetrics } from "../../metrics/types";
import { forEachJsonLineSync } from "../../protocol/jsonLines";
import { AUDIT_RESULTS_ROOT, containsNonFinite, runPython, writeJson } from "./auditUtils";
import { runAuditedEngine } from "./auditRun";

const METHODS = {
  riemannian: "experiments/methods/riemannian-default.json",
  goal: "experiments/methods/goal-projection.json",
  orca: "experiments/methods/orca-default.json",
  social_force: "experiments/methods/social-force-default.json",
} as const;

const RUNS: readonly { scenario: string; methods: readonly (keyof typeof METHODS)[] }[] = [
  { scenario: "single-free-space", methods: ["riemannian", "goal", "orca", "social_force"] },
  { scenario: "single-at-goal", methods: ["riemannian", "goal", "orca", "social_force"] },
  { scenario: "pairwise-separating", methods: ["riemannian", "goal", "orca", "social_force"] },
  { scenario: "pairwise-exact-symmetric", methods: ["riemannian"] },
  { scenario: "goal-projection-head-on", methods: ["goal"] },
  { scenario: "correction-disabled-head-on", methods: ["riemannian", "goal"] },
  { scenario: "wall-approach", methods: ["riemannian", "goal", "orca", "social_force"] },
] as const;

interface Check {
  id: string;
  description: string;
  status: "PASS" | "FAIL";
  observed?: unknown;
}

function records(path: string): EngineStepRecord[] {
  const result: EngineStepRecord[] = [];
  forEachJsonLineSync(path, (line) => result.push(validateEngineStepRecord(JSON.parse(line) as EngineStepRecord)));
  return result;
}

function check(condition: boolean, id: string, description: string, observed?: unknown): Check {
  return { id, description, status: condition ? "PASS" : "FAIL", observed };
}

function near(first: number, second: number, tolerance = 1e-10): boolean {
  return Math.abs(first - second) <= tolerance;
}

function auditExpectations(
  scenarioName: string,
  method: keyof typeof METHODS,
  steps: readonly EngineStepRecord[],
  metrics: RunMetrics,
): Check[] {
  const checks: Check[] = [check(!containsNonFinite({ steps, metrics }), "finite", "all emitted values are finite")];
  const firstStep = steps[0];
  const finalStep = steps.at(-1);
  if (firstStep === undefined || finalStep === undefined) return [...checks, check(false, "nonempty", "trajectory contains completed steps")];
  if (method === "orca" || method === "social_force") {
    checks.push(check(firstStep.diagnostics.correctionMode === "native_none", "native-mode", "native engine reports native_none"));
    checks.push(check(metrics.correctionDependence.totalCorrectionDisplacement === 0, "native-correction", "native engine reports zero positional correction", metrics.correctionDependence.totalCorrectionDisplacement));
  }
  if (scenarioName === "single-free-space") {
    const start = firstStep.agents[0].positionBefore[0];
    const finish = finalStep.agents[0].postCorrectionPosition[0];
    checks.push(check(finish > start, "positive-progress", "agent makes positive progress toward the horizontal goal", { start, finish }));
    checks.push(check(metrics.separation.minimumPreCorrectionAgentClearance === null, "agent-clearance-null", "single-agent clearance is null"));
    checks.push(check(metrics.separation.minimumPreCorrectionWallClearance === null, "wall-clearance-null", "wall clearance is null when no walls exist"));
    checks.push(check(metrics.correctionDependence.totalCorrectionDisplacement === 0, "no-correction", "free-space correction is zero"));
    const command = firstStep.agents[0].commandVelocity;
    if (method === "riemannian" || method === "goal") {
      checks.push(check(command[0] > 0 && near(command[1], 0), "scientific-command", "Scientific Core command points exactly toward the goal", command));
    } else if (method === "orca") {
      checks.push(check(command[0] > 0 && near(Math.hypot(...command), 1, 2e-6), "orca-command", "ORCA free-space command has preferred speed toward the goal", command));
    } else {
      checks.push(check(command[0] > 0, "social-force-command", "PySocialForce initially accelerates toward rather than away from the goal", command));
    }
  }
  if (scenarioName === "single-at-goal") {
    const initial = firstStep.agents[0].positionBefore;
    const stationary = steps.every((step) => {
      const agent = step.agents[0];
      return near(agent.postCorrectionPosition[0], initial[0]) && near(agent.postCorrectionPosition[1], initial[1]) && near(Math.hypot(...agent.realizedVelocity), 0);
    });
    checks.push(check(stationary, "held-at-goal", "agent starting inside goal disk remains stationary"));
    checks.push(check(metrics.completion.perAgent[0].firstArrivalTime !== null, "arrival-recorded", "post-step arrival is recorded"));
    checks.push(check(metrics.pathEfficiency.meanPathEfficiency === 0, "zero-path", "arrived agent has zero realized path ratio", metrics.pathEfficiency.meanPathEfficiency));
  }
  if (scenarioName === "pairwise-separating" && method === "riemannian") {
    const commands = firstStep.agents.map((agent) => agent.commandVelocity);
    checks.push(check(near(commands[0][0], -1) && near(commands[0][1], 0) && near(commands[1][0], 1) && near(commands[1][1], 0), "closing-gate", "separating Riemannian commands equal unobstructed goal steering", commands));
    checks.push(check(metrics.pairwise?.perAgent.every((agent) => agent.avoidanceOnsetTime === null) === true, "no-onset", "separating Riemannian encounter has no avoidance onset"));
  }
  if (scenarioName === "pairwise-exact-symmetric") {
    checks.push(check(firstStep.agents.every((agent) => near(agent.commandVelocity[1], 0)), "no-lateral-bias", "first commands contain no invented lateral preference", firstStep.agents.map((agent) => agent.commandVelocity)));
  }
  if (scenarioName === "goal-projection-head-on") {
    const pre = metrics.pairwise?.minimumPreCorrectionPhysicalClearance;
    const post = metrics.pairwise?.minimumPostCorrectionPhysicalClearance;
    checks.push(check(typeof pre === "number" && pre < 0, "raw-overlap", "pre-correction physical clearance is negative", pre));
    checks.push(check(typeof post === "number" && post >= -1e-10, "projection-repair", "post-correction physical clearance is nonnegative within tolerance", post));
    checks.push(check(metrics.correctionDependence.totalCorrectionDisplacement > 0, "projection-measured", "projection displacement is positive", metrics.correctionDependence.totalCorrectionDisplacement));
  }
  if (scenarioName === "correction-disabled-head-on") {
    const identical = steps.every((step) => step.agents.every((agent) => near(agent.preCorrectionPosition[0], agent.postCorrectionPosition[0]) && near(agent.preCorrectionPosition[1], agent.postCorrectionPosition[1])));
    const contactEqual = steps.every((step) => step.diagnostics.preCorrectionOverlapPairs === step.diagnostics.postCorrectionOverlapPairs);
    checks.push(check(identical, "disabled-pre-post", "pre/post positions are identical when correction is disabled"));
    checks.push(check(contactEqual, "disabled-contacts", "pre/post overlap counts are identical when correction is disabled"));
    checks.push(check(metrics.correctionDependence.totalCorrectionDisplacement === 0, "disabled-displacement", "disabled correction displacement is exactly zero"));
  }
  if (scenarioName === "wall-approach") {
    checks.push(check(metrics.separation.minimumPreCorrectionAgentClearance === null, "wall-agent-null", "agent clearance is null in the one-agent wall fixture"));
    checks.push(check(metrics.separation.minimumPreCorrectionWallClearance !== null, "wall-finite", "wall clearance is independently finite", metrics.separation.minimumPreCorrectionWallClearance));
    checks.push(check(metrics.separation.maximumPreCorrectionAgentPenetration === 0, "wall-separate", "wall contact does not populate agent penetration", metrics.separation.maximumPreCorrectionAgentPenetration));
  }
  return checks;
}

export interface GoldAuditResult {
  status: "PASS";
  runCount: number;
  checkCount: number;
  reportPath: string;
  svgPaths: string[];
}

export function runGoldAudit(): GoldAuditResult {
  const root = resolve(AUDIT_RESULTS_ROOT, "gold");
  mkdirSync(root, { recursive: true });
  const runReports: unknown[] = [];
  const svgPaths: string[] = [];
  let firstFailure: { scenario: string; method: string; check: Check } | null = null;
  let checkCount = 0;
  for (const definition of RUNS) {
    const scenarioPath = resolve("experiments", "audit", "scenarios", `${definition.scenario}.json`);
    for (const method of definition.methods) {
      const outputRoot = resolve(root, definition.scenario, method);
      const run = runAuditedEngine(scenarioPath, METHODS[method], outputRoot);
      const independentPath = resolve(outputRoot, "independent-metrics.json");
      const comparisonPath = resolve(outputRoot, "metric-comparison.json");
      runPython("experiments/audit/python/evaluate_metrics.py", ["--scenario", scenarioPath, "--trajectory", run.trajectoryPath, "--out", independentPath]);
      runPython("experiments/audit/python/compare_metrics.py", ["--pipeline", run.metricsPath, "--independent", independentPath, "--report", comparisonPath]);
      const metrics = JSON.parse(readFileSync(run.metricsPath, "utf8")) as RunMetrics;
      const engineSteps = records(run.trajectoryPath);
      const checks = auditExpectations(definition.scenario, method, engineSteps, metrics);
      checks.push(check((JSON.parse(readFileSync(comparisonPath, "utf8")) as { status: string }).status === "PASS", "independent-metrics", "independent metrics equal production metrics"));
      checkCount += checks.length;
      const failed = checks.find((entry) => entry.status === "FAIL");
      if (failed !== undefined && firstFailure === null) firstFailure = { scenario: definition.scenario, method, check: failed };
      const svgPath = resolve(outputRoot, "trajectory.svg");
      runPython("experiments/audit/python/render_trajectory_svg.py", ["--scenario", scenarioPath, "--trajectory", run.trajectoryPath, "--out", svgPath, "--method", method]);
      svgPaths.push(svgPath);
      runReports.push({ scenario: definition.scenario, method, checks, evidence: { manifest: run.manifestPath, trajectory: run.trajectoryPath, metrics: run.metricsPath, comparison: comparisonPath, svg: svgPath } });
    }
  }
  const reportPath = resolve(root, "report.json");
  writeJson(reportPath, { goldAuditVersion: 1, status: firstFailure === null ? "PASS" : "FAIL", runCount: runReports.length, checkCount, firstFailure, runs: runReports });
  if (firstFailure !== null) throw new Error(`Gold audit failed ${firstFailure.scenario}/${firstFailure.method}/${firstFailure.check.id}; see ${reportPath}`);
  return { status: "PASS", runCount: runReports.length, checkCount, reportPath, svgPaths };
}

function main(): void {
  try {
    const result = runGoldAudit();
    console.log(`audit:gold passed ${result.checkCount} checks across ${result.runCount} runs`);
  } catch (error) {
    console.error(`audit:gold failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) main();
