import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSnapshots } from "./generateRiemannianSnapshots";
import { evaluateSnapshots } from "./evaluateRiemannianSnapshots";
import { AUDIT_RESULTS_ROOT, runPython } from "./auditUtils";

export interface RiemannianAuditResult {
  status: "PASS" | "FAIL";
  caseCount: number;
  maximumMetricEntryError: number;
  maximumTargetVelocityError: number;
  maximumInvariantError: number;
  reportPath: string;
}

export function runRiemannianAudit(): RiemannianAuditResult {
  const snapshotsPath = resolve("experiments", "audit", "fixtures", "riemannian-snapshots.jsonl");
  if (!existsSync(snapshotsPath)) throw new Error("Committed Riemannian snapshot fixture is missing");
  const expectedFixture = buildSnapshots().map((snapshot) => JSON.stringify(snapshot)).join("\n") + "\n";
  if (readFileSync(snapshotsPath, "utf8") !== expectedFixture) {
    throw new Error("Committed Riemannian snapshot fixture differs from its deterministic generator");
  }
  const outputRoot = resolve(AUDIT_RESULTS_ROOT, "riemannian");
  const independentPath = resolve(outputRoot, "independent.jsonl");
  const productionPath = resolve(outputRoot, "production.jsonl");
  const reportPath = resolve(outputRoot, "comparison.json");
  runPython("experiments/audit/python/riemannian_reference.py", ["--snapshots", snapshotsPath, "--out", independentPath]);
  const count = evaluateSnapshots(snapshotsPath, productionPath);
  if (count !== 107) throw new Error(`Expected 107 Riemannian snapshots, received ${count}`);
  runPython("experiments/audit/python/compare_riemannian.py", [
    "--snapshots", snapshotsPath,
    "--independent", independentPath,
    "--production", productionPath,
    "--report", reportPath,
  ]);
  const result = JSON.parse(readFileSync(reportPath, "utf8")) as RiemannianAuditResult;
  if (result.status !== "PASS") throw new Error(`Riemannian audit mismatch; see ${reportPath}`);
  return { ...result, reportPath };
}

function main(): void {
  try {
    const result = runRiemannianAudit();
    console.log(`audit:riemannian passed ${result.caseCount} cases; max metric=${result.maximumMetricEntryError}, velocity=${result.maximumTargetVelocityError}`);
  } catch (error) {
    console.error(`audit:riemannian failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) main();
