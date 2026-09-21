import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assignmentIdentity, buildAssignments, loadStudy, reproductionStudy, requireHumanReviewGate } from "../../experiments/lean/run";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function temporary(): string {
  const root = mkdtempSync(resolve(tmpdir(), "paper-reproduction-")); roots.push(root); return root;
}
describe("independent paper reproduction", () => {
  it("relocates every output and review gate while preserving all 416 assignments", () => {
    const frozen = loadStudy(); const root = temporary();
    const rerun = reproductionStudy(frozen, root);
    const phases = ["audit", "test", "ablation", "runtime"] as const;
    const before = phases.flatMap(phase => buildAssignments(frozen, phase));
    const after = phases.flatMap(phase => buildAssignments(rerun, phase));
    expect(after).toHaveLength(416);
    expect(after.map(assignmentIdentity)).toEqual(before.map(assignmentIdentity));
    expect(after.every(a => a.outputRoot === root)).toBe(true);
    expect(Object.values(rerun.outputs).every(path => path.startsWith(root))).toBe(true);
    expect(rerun.humanReviewGate).toBe(resolve(root, "audit/review-approved.txt"));
    expect(frozen.outputs.root).toBe("results/final-camera-ready-jupedsim-v2");
  });
  it("does not inherit approval from another reproduction", () => {
    const old = reproductionStudy(loadStudy(), temporary());
    mkdirSync(old.outputs.auditRoot, { recursive: true });
    writeFileSync(old.humanReviewGate, "approved by reviewer\n");
    const fresh = reproductionStudy(loadStudy(), temporary());
    expect(() => requireHumanReviewGate(old.humanReviewGate)).not.toThrow();
    expect(() => requireHumanReviewGate(fresh.humanReviewGate)).toThrow(/Human visual review/);
  });
  it.each([".", "paper", "paper/new", "results/final-camera-ready-jupedsim-v2", "results/final-camera-ready-jupedsim-v2/new"])("protects %s", path => {
    expect(() => reproductionStudy(loadStudy(), path)).toThrow(/reserved|archived/);
  });
  it("protects a relocated archive marked as immutable", () => {
    const root = temporary(); writeFileSync(resolve(root, "ARCHIVED-EVIDENCE"), "paper archive\n");
    expect(() => reproductionStudy(loadStudy(), resolve(root, "nested"))).toThrow(/archived/);
  });
});
