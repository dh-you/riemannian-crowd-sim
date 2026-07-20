import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { forEachJsonLineSync } from "../protocol/jsonLines";
import { packageViewerTrajectories } from "./worker";
import { loadStudy, runPool, type Assignment, type RunRecord } from "./run";

const SCENARIOS = ["head-on", "crossing", "circle", "corridor", "bottleneck"] as const;

interface SmokeRow {
  scenario: string;
  method: string;
  methodId: string;
  completionFraction: number;
  conditionalMedianNormalizedCompletionTime: number | null;
  rawPreCorrectionOverlapExposure: number | null;
  maximumPhysicalPenetration: number;
  rmsAcceleration: number | null;
  minimumPhysicalClearance: number | null;
  maximumObservedCommandAcceleration: number;
  correctionMode: string;
  runtimeSeconds: number;
  invalidNonfiniteStateCount: number;
  artifactDirectory: string;
}

export async function runSfmRadiusSmokes(jobs = 1): Promise<{ rows: SmokeRow[]; outputDirectory: string }> {
  const canonical = loadStudy();
  const repair = loadStudy(resolve("experiments/lean/study-sfm-radius.json"));
  const legacy = canonical.methods["social-force"] as { id: string };
  const radius = repair.methods["social-force-radius"] as { id: string };
  if (legacy?.id !== "social_force_pysocialforce_v1") throw new Error("Canonical legacy SFM is missing");
  if (radius?.id !== "social_force_pysocialforce_radius_v2") throw new Error("Repair SFM is missing");
  if (Object.keys(repair.methods).length !== 1) throw new Error("Repair study contains a non-SFM method");
  const outputDirectory = resolve(repair.outputs.root, "smoke");
  const rawPath = resolve(outputDirectory, "raw-runs.jsonl");
  const comparisonPath = resolve(outputDirectory, "old-vs-radius-aware-smoke.json");
  if (existsSync(rawPath) || existsSync(comparisonPath)) {
    throw new Error(`Smoke output already exists; preserve and inspect it: ${outputDirectory}`);
  }
  const assignments: Assignment[] = SCENARIOS.flatMap((scenarioType) => [
    {
      phase: "smoke",
      scenarioType,
      seed: 0,
      method: "legacy-social-force",
      scenario: repair.scenarios[scenarioType],
      methodConfig: legacy,
      outputRoot: outputDirectory,
      visual: true,
    },
    {
      phase: "smoke",
      scenarioType,
      seed: 0,
      method: "social-force-radius",
      scenario: repair.scenarios[scenarioType],
      methodConfig: radius,
      outputRoot: outputDirectory,
      visual: true,
    },
  ]);
  const records = await runPool(assignments, jobs);
  if (records.some((record) => record.status !== "PASS")) {
    throw new Error(`SFM smoke failure: ${records.filter((record) => record.status !== "PASS").map((record) => record.error).join("; ")}`);
  }
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(rawPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  packageViewerTrajectories(resolve(outputDirectory, "audit"));
  const rows = records.map(smokeRow).sort((a, b) =>
    SCENARIOS.indexOf(a.scenario as typeof SCENARIOS[number]) - SCENARIOS.indexOf(b.scenario as typeof SCENARIOS[number])
    || a.method.localeCompare(b.method));
  writeFileSync(comparisonPath, `${JSON.stringify({
    smokeComparisonVersion: 1,
    status: "fixed audit-seed engineering diagnostic; not held-out aggregate evidence",
    seed: 0,
    maximumObservedCommandAccelerationDefinition:
      "max ||commandVelocity - velocityBefore|| / dt over logged agent-steps; command velocity is post-force, post-speed-cap native velocity",
    rows,
  }, null, 2)}\n`, "utf8");
  writeFileSync(resolve(outputDirectory, "old-vs-radius-aware-smoke.csv"), toCsv(rows), "utf8");
  writeFileSync(resolve(outputDirectory, "old-vs-radius-aware-smoke.md"), toMarkdown(rows), "utf8");
  return { rows, outputDirectory };
}

function smokeRow(record: RunRecord): SmokeRow {
  const artifactDirectory = String(record.artifactDirectory);
  const scenario = JSON.parse(readFileSync(resolve(artifactDirectory, "scenario.json"), "utf8")) as {
    simulation: { dt: number };
  };
  const manifest = JSON.parse(readFileSync(resolve(artifactDirectory, "audit-manifest.json"), "utf8")) as {
    methodId: string;
  };
  let maximumObservedCommandAcceleration = 0;
  let invalidNonfiniteStateCount = 0;
  forEachJsonLineSync(resolve(artifactDirectory, "engine-steps-full.jsonl"), (line) => {
    const step = JSON.parse(line) as {
      agents: Array<{ velocityBefore: [number, number]; commandVelocity: [number, number] }>;
    };
    invalidNonfiniteStateCount += countNonfinite(step);
    for (const agent of step.agents) {
      const ax = (agent.commandVelocity[0] - agent.velocityBefore[0]) / scenario.simulation.dt;
      const ay = (agent.commandVelocity[1] - agent.velocityBefore[1]) / scenario.simulation.dt;
      maximumObservedCommandAcceleration = Math.max(maximumObservedCommandAcceleration, Math.hypot(ax, ay));
    }
  });
  return {
    scenario: record.scenarioType,
    method: record.method,
    methodId: manifest.methodId,
    completionFraction: Number(record.successFraction),
    conditionalMedianNormalizedCompletionTime: nullableNumber(record.normalizedCompletionTime),
    rawPreCorrectionOverlapExposure: nullableNumber(record.preCorrectionOverlapExposure),
    maximumPhysicalPenetration: Number(record.maximumPhysicalPenetration),
    rmsAcceleration: nullableNumber(record.rmsAcceleration),
    minimumPhysicalClearance: nullableNumber(record.minimumPhysicalClearance),
    maximumObservedCommandAcceleration,
    correctionMode: String(record.correctionMode),
    runtimeSeconds: record.runtimeSeconds,
    invalidNonfiniteStateCount,
    artifactDirectory,
  };
}

function nullableNumber(value: unknown): number | null {
  return value === null ? null : Number(value);
}

function countNonfinite(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? 0 : 1;
  if (Array.isArray(value)) return value.reduce((sum, entry) => sum + countNonfinite(entry), 0);
  if (value !== null && typeof value === "object") {
    return Object.values(value).reduce((sum, entry) => sum + countNonfinite(entry), 0);
  }
  return 0;
}

function toCsv(rows: readonly SmokeRow[]): string {
  const columns = Object.keys(rows[0]) as Array<keyof SmokeRow>;
  return `${columns.join(",")}\n${rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")).join("\n")}\n`;
}

function csvCell(value: unknown): string {
  if (value === null) return "";
  const source = String(value);
  return /[",\r\n]/u.test(source) ? `"${source.replaceAll('"', '""')}"` : source;
}

function toMarkdown(rows: readonly SmokeRow[]): string {
  const header = "| Scenario | Method | Completion | Cond. median NCT | Overlap exposure | Max penetration (m) | RMS accel. | Min clearance (m) | Max observed cmd accel. | Correction | Runtime (s) | Invalid/nonfinite |";
  const separator = "|---|---|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|";
  const body = rows.map((row) => `| ${row.scenario} | ${row.method} | ${format(row.completionFraction)} | ${format(row.conditionalMedianNormalizedCompletionTime)} | ${format(row.rawPreCorrectionOverlapExposure)} | ${format(row.maximumPhysicalPenetration)} | ${format(row.rmsAcceleration)} | ${format(row.minimumPhysicalClearance)} | ${format(row.maximumObservedCommandAcceleration)} | ${row.correctionMode} | ${format(row.runtimeSeconds)} | ${row.invalidNonfiniteStateCount} |`);
  return [
    "# Legacy versus radius-aware PySocialForce smoke comparison",
    "",
    "Fixed audit seed 0 engineering diagnostic; this is not held-out aggregate evidence.",
    "",
    header,
    separator,
    ...body,
    "",
    "Maximum observed command acceleration is `max ||commandVelocity - velocityBefore|| / dt`; the command velocity is the post-force, post-speed-cap native PySocialForce velocity.",
    "",
  ].join("\n");
}

function format(value: number | null): string {
  return value === null ? "—" : Number(value.toPrecision(6)).toString();
}

async function main(): Promise<void> {
  const jobsIndex = process.argv.indexOf("--jobs");
  const jobs = jobsIndex < 0 ? 1 : Number(process.argv[jobsIndex + 1]);
  if (!Number.isSafeInteger(jobs) || jobs < 1) throw new Error("--jobs must be a positive integer");
  const result = await runSfmRadiusSmokes(jobs);
  console.log(`SFM radius smokes: ${result.rows.length} PASS rows at ${result.outputDirectory}`);
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  main().catch((error) => {
    console.error(`SFM radius smokes failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
