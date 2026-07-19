import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateReviewIndex } from "../experiments/audit/viewer/generateReviewIndex";
import {
  assertUniqueAssignments, assignmentIdentity, buildAssignments, buildBenchmarkAssignments,
  loadStudy, pendingAssignments, requireHumanReviewGate, runKey, runPool, validateWorkerRecord,
  type Assignment, type RunRecord,
} from "../experiments/lean/run";

const temporary: string[] = [];
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
    expect(buildAssignments(study, "audit")).toHaveLength(32);
    expect(buildBenchmarkAssignments(study)).toHaveLength(8);
    expect(buildAssignments(study, "test")).toHaveLength(360);
    expect(buildAssignments(study, "ablation")).toHaveLength(60);
    const runtime = buildAssignments(study, "runtime");
    expect(runtime).toHaveLength(48);
    expect(runtime.filter((entry) => entry.warmup)).toHaveLength(12);
    expect(new Set([...buildAssignments(study, "audit"), ...runtime].map(runKey)).size).toBe(80);
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

  it("creates viewer artifacts and passes independent Python verification", async () => {
    const root = directory(); const [record] = await runPool([fixture(root, 4, true)], 1);
    expect(record.status).toBe("PASS"); const runDirectory = String(record.artifactDirectory);
    expect(existsSync(resolve(runDirectory, "engine-steps.jsonl"))).toBe(true);
    const viewer = generateReviewIndex({ auditRoot: resolve(root, "audit"), outputDirectory: resolve(root, "audit/viewer") });
    expect(viewer.runCount).toBe(1);
    expect(readFileSync(resolve(root, "audit/viewer/review-data.js"), "utf8")).toContain("free_space");
    const python = process.platform === "win32" ? "python" : "python3";
    const checked = spawnSync(python, [resolve("experiments/lean/analyze.py"), "--verify-run", runDirectory], { encoding: "utf8" });
    expect(checked.status, checked.stdout + checked.stderr).toBe(0);
  });
});
