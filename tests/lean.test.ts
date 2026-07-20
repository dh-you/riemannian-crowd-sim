import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateReviewIndex } from "../experiments/audit/viewer/generateReviewIndex";
import type { EngineStepRecord } from "../experiments/engines/engineStep";
import { metricRecord, packageViewerTrajectories } from "../experiments/lean/worker";
import type { RunMetrics } from "../experiments/metrics/types";
import {
  assertUniqueAssignments, assignmentIdentity, buildAssignments, buildBenchmarkAssignments,
  loadStudy, pendingAssignments, requireHumanReviewGate, runKey, runPool, validateWorkerRecord,
  type Assignment, type RunRecord,
} from "../experiments/lean/run";
import { compareScientificValues } from "../experiments/lean/verifyFinalEvidence";
const temporary: string[] = [];
const PAPER_METRICS = [
  "successFraction",
  "normalizedCompletionTime",
  "maximumPhysicalPenetration",
  "preCorrectionOverlapExposure",
  "rmsAcceleration",
] as const;
afterEach(() => temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));
function directory(): string { const path = mkdtempSync(resolve(tmpdir(), "lean-test-")); temporary.push(path); return path; }
function fixture(root: string, seed: number, visual = false): Assignment {
  const study = loadStudy();
  return { phase: "fixture", scenarioType: `free-${seed}`, seed, method: "goal",
    scenario: { family: "free_space", variant: "single_agent" }, methodConfig: study.methods.goal,
    outputRoot: root, visual };
}
function stable(records: RunRecord[]): unknown { return records.map(({ runtimeSeconds: _runtime, ...record }) => record); }

describe("camera-ready lean harness", () => {
  it("builds the exact unique approved matrices", () => {
    const study = loadStudy();
    expect(buildAssignments(study, "audit")).toHaveLength(28);
    expect(buildBenchmarkAssignments(study)).toHaveLength(8);
    expect(buildAssignments(study, "test")).toHaveLength(280);
    expect(buildAssignments(study, "ablation")).toHaveLength(60);
    const runtime = buildAssignments(study, "runtime");
    expect(runtime).toHaveLength(48);
    expect(runtime.filter((entry) => entry.warmup)).toHaveLength(12);
    expect(new Set([...buildAssignments(study, "audit"), ...runtime].map(runKey)).size).toBe(76);
    expect(study.audit.visual.scenarioTypes).toEqual([
      "head-on", "crossing", "circle", "corridor", "bottleneck",
    ]);
    expect(Object.keys(study.methods)).toEqual(["riemannian", "goal", "orca", "jupedsim-sfm"]);
    expect(study.outputs.root).toBe("results/final-camera-ready-jupedsim");
    expect([
      ...study.headline.pairwise.scenarioTypes,
      ...study.headline.dense.scenarioTypes,
    ]).toEqual(["head-on", "crossing", "circle", "corridor", "bottleneck"]);
  });

  it("rejects duplicate keys and changed resume identities", () => {
    const assignment = fixture(directory(), 1);
    expect(() => assertUniqueAssignments([assignment, assignment])).toThrow(/Duplicate/u);
    const pass = { key: runKey(assignment), assignmentIdentity: assignmentIdentity(assignment), phase: assignment.phase,
      scenarioType: assignment.scenarioType, seed: 1, method: "goal", status: "PASS", runtimeSeconds: 1 } as RunRecord;
    expect(pendingAssignments([assignment], new Map([[pass.key, pass]]), true)).toHaveLength(0);
    const changed = { ...pass, assignmentIdentity: { changed: true } };
    expect(() => pendingAssignments([assignment], new Map([[pass.key, changed]]), true)).toThrow(/identity changed/u);
    expect(pendingAssignments([assignment], new Map([[pass.key, { ...pass, status: "FAIL" }]]), true)).toEqual([assignment]);
  });

  it("enforces the human-review gate", () => {
    const root = directory(); const gate = resolve(root, "review-approved.txt");
    expect(() => requireHumanReviewGate(gate)).toThrow(/Human visual review/u);
    writeFileSync(gate, "approved by reviewer\n");
    expect(() => requireHumanReviewGate(gate)).not.toThrow();
  });

  it("produces numerically identical serial and parallel results", async () => {
    const root = directory(); const assignments = [fixture(root, 1), fixture(root, 2)];
    const serial = await runPool(assignments, 1); const parallel = await runPool(assignments, 2);
    expect(serial.every((record) => record.status === "PASS")).toBe(true);
    expect(stable(parallel)).toEqual(stable(serial));
  });

  it("records worker failures explicitly", async () => {
    const assignment = { ...fixture(directory(), 3), scenario: { family: "invalid", variant: "invalid" } };
    const [record] = await runPool([assignment], 1);
    expect(record.status).toBe("FAIL"); expect(record.error).toMatch(/Unsupported scenario family/u);
    expect(record.successFraction).toBeNull();
  });

  it("rejects non-finite worker output", () => {
    expect(() => validateWorkerRecord({ key: "x", status: "PASS", runtimeSeconds: Infinity })).toThrow(/non-finite/u);
  });

  it("uses the retained scientific tolerances and reports the first divergence", () => {
    expect(() => compareScientificValues(
      { position: [1, 2] },
      { position: [1 + 5e-9, 2] },
      "trajectory",
      1e-8,
    )).not.toThrow();
    expect(() => compareScientificValues(
      { position: [1, 2] },
      { position: [1.01, 2] },
      "trajectory",
      1e-8,
    )).toThrow(/trajectory\.position\[0\]: numeric divergence/u);
    expect(() => compareScientificValues(Number.NaN, 0, "metric", 1e-8))
      .toThrow(/numeric divergence/u);
  });

  it("creates viewer artifacts and passes independent Python verification", async () => {
    const root = directory(); const assignment = fixture(root, 4, true);
    const [record] = await runPool([assignment], 1);
    expect(record.status).toBe("PASS"); const runDirectory = String(record.artifactDirectory);
    const packaged = packageViewerTrajectories(resolve(root, "audit")); expect(packaged.runCount).toBe(1);
    const fullPath = resolve(runDirectory, "engine-steps-full.jsonl");
    const fullSource = readFileSync(fullPath, "utf8");
    const full = fullSource.trim().split(/\r?\n/u);
    const sampled = readFileSync(resolve(runDirectory, "engine-steps.jsonl"), "utf8").trim().split(/\r?\n/u);
    expect(full.length).toBeGreaterThan(sampled.length);
    expect(JSON.parse(sampled[0]).stepIndex).toBe(JSON.parse(full[0]).stepIndex);
    expect(JSON.parse(sampled.at(-1) as string).stepIndex).toBe(JSON.parse(full.at(-1) as string).stepIndex);
    const viewer = generateReviewIndex({ auditRoot: resolve(root, "audit"), outputDirectory: resolve(root, "audit/viewer") });
    expect(viewer.runCount).toBe(1);
    expect(readFileSync(resolve(root, "audit/viewer/review-data.js"), "utf8")).toContain("free_space");
    const python = process.platform === "win32" ? "python" : "python3";
    const verify = () => spawnSync(
      python,
      [resolve("experiments/lean/analyze.py"), "--verify-run", runDirectory],
      { encoding: "utf8" },
    );
    const checked = verify();
    expect(checked.status, checked.stdout + checked.stderr).toBe(0);

    const metricsPath = resolve(runDirectory, "run-metrics.json");
    const metricsSource = readFileSync(metricsPath, "utf8");
    const metrics = JSON.parse(metricsSource) as RunMetrics;
    const flattened = metricRecord(
      assignment,
      {
        ...metrics,
        completionTime: {
          meanNormalizedCompletionTime: 101,
          medianNormalizedCompletionTime: 202,
        },
      },
      1,
      runDirectory,
      0,
    );
    expect(flattened.normalizedCompletionTime).toBe(202);
    for (const metric of PAPER_METRICS) expect(record).toHaveProperty(metric);

    const overlapTamper = full.map((line) => JSON.parse(line) as EngineStepRecord);
    overlapTamper[0].diagnostics.preCorrectionOverlapPairs += 1;
    writeFileSync(fullPath, `${overlapTamper.map((step) => JSON.stringify(step)).join("\n")}\n`);
    const overlapRejected = verify();
    expect(overlapRejected.status).not.toBe(0);
    expect(overlapRejected.stderr).toMatch(/pre-correction overlap exposure/u);
    writeFileSync(fullPath, fullSource);

    const velocityTamper = full.map((line) => JSON.parse(line) as EngineStepRecord);
    velocityTamper[0] = {
      ...velocityTamper[0],
      agents: velocityTamper[0].agents.map((agent, index) => index === 0
        ? { ...agent, realizedVelocity: [agent.realizedVelocity[0] + 1, agent.realizedVelocity[1]] }
        : agent),
    };
    writeFileSync(fullPath, `${velocityTamper.map((step) => JSON.stringify(step)).join("\n")}\n`);
    const velocityRejected = verify();
    expect(velocityRejected.status).not.toBe(0);
    expect(velocityRejected.stderr).toMatch(/rms acceleration/u);
    writeFileSync(fullPath, fullSource);

    if (metrics.smoothness.rmsAcceleration === null) throw new Error("Fixture RMS acceleration is unavailable");
    metrics.smoothness.rmsAcceleration += 1;
    writeFileSync(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`);
    const metricRejected = verify();
    expect(metricRejected.status).not.toBe(0);
    expect(metricRejected.stderr).toMatch(/rms acceleration/u);
    writeFileSync(metricsPath, metricsSource);
  });

  it("summarizes all five paper metrics with estimates and paired differences", () => {
    const root = directory();
    const rawPath = resolve(root, "raw.jsonl");
    const summaryPath = resolve(root, "summary.csv");
    const common = {
      phase: "test", scenarioType: "head-on", seed: 400, repetition: null,
      status: "PASS", warmup: false, legacyPointGoalSuccessFraction: 1,
      pathRatio: 1.1, minimumPhysicalClearance: 0.2, correctionRatio: 0.01,
      throughput: 0.5, pairwiseAvoidanceOnsetRate: 1, runtimeSeconds: 1,
    };
    const records = [
      {
        ...common, key: "test/head-on/400/riemannian", method: "riemannian",
        successFraction: 1, normalizedCompletionTime: 1.2,
        maximumPhysicalPenetration: 0.01, preCorrectionOverlapExposure: 0.02,
        rmsAcceleration: 0.3,
      },
      {
        ...common, key: "test/head-on/400/goal", method: "goal",
        successFraction: 0.5, normalizedCompletionTime: 1.4,
        maximumPhysicalPenetration: 0.03, preCorrectionOverlapExposure: 0.04,
        rmsAcceleration: 0.6,
      },
    ];
    writeFileSync(rawPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    const python = process.platform === "win32" ? "python" : "python3";
    const summarized = spawnSync(
      python,
      [resolve("experiments/lean/analyze.py"), "--summarize", rawPath, summaryPath],
      { encoding: "utf8" },
    );
    expect(summarized.status, summarized.stdout + summarized.stderr).toBe(0);
    const [header, ...data] = readFileSync(summaryPath, "utf8").trim().split(/\r?\n/u);
    const columns = header.split(",");
    const rows = data.map((line) => Object.fromEntries(
      line.split(",").map((value, index) => [columns[index], value]),
    ));
    for (const metric of PAPER_METRICS) {
      const selected = rows.filter((row) => row.metric === metric);
      expect(selected.filter((row) => row.row_type === "estimate")).toHaveLength(2);
      expect(selected.filter((row) => row.row_type === "paired_difference")).toHaveLength(1);
      for (const row of selected) {
        for (const field of ["n", "failures", "median", "q1", "q3", "unit"] as const) {
          expect(row[field]).not.toBe("");
        }
      }
    }

    const paperPath = resolve(root, "paper-facing.csv");
    const paper = spawnSync(
      python,
      [resolve("experiments/lean/analyze.py"), "--paper-summary", rawPath, paperPath],
      { encoding: "utf8" },
    );
    expect(paper.status, paper.stdout + paper.stderr).toBe(0);
    const paperRows = readFileSync(paperPath, "utf8").trim().split(/\r?\n/u);
    expect(paperRows).toHaveLength(1 + PAPER_METRICS.length * 2);
    expect(new Set(paperRows.slice(1).map((line) => line.split(",")[2])))
      .toEqual(new Set(PAPER_METRICS));
  });
});
