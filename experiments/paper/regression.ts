import { execFileSync } from "node:child_process";
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { buildAssignments, loadStudy, reproductionStudy, runPool } from "../lean/run";
import { compareScientificValues } from "../lean/verifyFinalEvidence";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

async function compareTrajectories(actual: string, expected: string, tolerance: number): Promise<number> {
  const a = createInterface({ input: createReadStream(actual), crlfDelay: Infinity });
  const b = createInterface({ input: createReadStream(expected), crlfDelay: Infinity });
  const iterator = b[Symbol.asyncIterator](); let steps = 0;
  try {
    for await (const line of a) {
      const prior = await iterator.next();
      if (prior.done) throw new Error(`Archived trajectory is shorter: ${expected}`);
      compareScientificValues(JSON.parse(line), JSON.parse(prior.value), `step[${steps}]`, tolerance);
      steps += 1;
    }
    if (!(await iterator.next()).done) throw new Error(`New trajectory is shorter: ${actual}`);
  } finally { a.close(); b.close(); }
  return steps;
}

async function main(): Promise<void> {
  const canonical = option("--canonical");
  if (!canonical) throw new Error("Pass --canonical <extracted-evidence-root>");
  const archivedRoot = resolve(canonical);
  const study = reproductionStudy(loadStudy(), option("--out") ?? "results/publication-regression");
  const archived = new Map(readFileSync(resolve(archivedRoot, "raw-runs.jsonl"), "utf8").trim().split(/\r?\n/)
    .map(line => { const value = JSON.parse(line); return [value.key, value] as const; }));
  const assignments = buildAssignments(study, "audit").filter(a => a.visual);
  const records = await runPool(assignments, 4, record => console.log(`${record.status}: ${record.key}`));
  const comparisons = [];
  for (const record of records) {
    if (record.status !== "PASS") throw new Error(`Failed regression run: ${record.key}: ${record.error}`);
    const prior = archived.get(record.key);
    if (!prior || prior.status !== "PASS") throw new Error(`Missing archived run ${record.key}`);
    const tolerance = record.method === "orca" ? 1e-6 : 1e-8;
    // Every recorded scalar scientific metric; runtime is intentionally hardware-dependent.
    const scientific = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row)
      .filter(([key, value]) => key !== "runtimeSeconds" && (typeof value === "number" || value === null)));
    compareScientificValues(scientific(record), scientific(prior), record.key, tolerance);
    compareScientificValues(record.assignmentIdentity, prior.assignmentIdentity, `${record.key}.assignment`, 0);
    const directory = String(record.artifactDirectory);
    const manifest = JSON.parse(readFileSync(resolve(directory, "audit-manifest.json"), "utf8"));
    const archivedDirectory = resolve(archivedRoot, "audit/visuals/runs", manifest.scenarioName, manifest.methodKey);
    const steps = await compareTrajectories(resolve(directory, "engine-steps.jsonl"),
      resolve(archivedDirectory, "engine-steps-full.jsonl"), tolerance);
    comparisons.push({ key: record.key, tolerance, steps, status: "PASS" });
  }
  if (comparisons.length !== 20) throw new Error("Expected four methods by five scenarios");
  mkdirSync(study.outputs.root, { recursive: true });
  writeFileSync(resolve(study.outputs.root, "regression.json"), JSON.stringify({
    status: "PASS", scientificReferenceCommit: "05241d55a90a7b873d0a403a30682e8577f8111d",
    cleanupImplementationCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    comparison: "All scalar scientific run metrics and every full-rate engine-step record; excludes wall-clock timing and environment provenance",
    comparisons,
  }, null, 2) + "\n");
  console.log("PASS: all 20 full trajectories and scientific metrics match the archived reference");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
