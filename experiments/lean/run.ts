import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { generateReviewIndex } from "../audit/viewer/generateReviewIndex";
export type ScenarioSpec = { family: string; variant: string; agentCount?: number };
export type Assignment = {
  phase: string; scenarioType: string; seed: number; method: string;
  scenario: ScenarioSpec; methodConfig: unknown; outputRoot: string;
  visual?: boolean; ablation?: string; repetition?: number; warmup?: boolean;
};
export type RunRecord = Record<string, unknown> & {
  key: string; assignmentIdentity: unknown; phase: string; scenarioType: string;
  seed: number; method: string; status: "PASS" | "FAIL"; runtimeSeconds: number;
};
type Matrix = { scenarioTypes: string[]; seeds: number[] };
export type LeanStudy = {
  methods: Record<string, unknown>; scenarios: Record<string, ScenarioSpec>;
  audit: { visual: Matrix; diagnostics: Matrix };
  benchmark: Matrix & { jobs: number[] };
  headline: { pairwise: Matrix; dense: Matrix };
  ablations: { scenarioTypes: string[]; seeds: number[]; variants: Record<string, Record<string, unknown>> };
  runtime: { scenario: string; agentCounts: number[]; seed: number; warmups: number; measuredRepetitions: number; jobs: number };
  outputs: { root: string; raw: string; summary: string; auditRoot: string; benchmark: string };
  humanReviewGate: string;
};
export function loadStudy(path = resolve("experiments/lean/study.json")): LeanStudy {
  return JSON.parse(readFileSync(path, "utf8")) as LeanStudy;
}
function matrix(study: LeanStudy, phase: string, spec: Matrix, visual = false): Assignment[] {
  return spec.scenarioTypes.flatMap((scenarioType) => spec.seeds.flatMap((seed) =>
    Object.entries(study.methods).map(([method, methodConfig]) => ({
      phase, scenarioType, seed, method, scenario: requireScenario(study, scenarioType),
      methodConfig, outputRoot: study.outputs.root, visual,
    }))));
}
export function buildAssignments(study: LeanStudy, phase: "audit" | "test" | "ablation" | "runtime"): Assignment[] {
  let assignments: Assignment[];
  if (phase === "audit") assignments = [
    ...matrix(study, phase, study.audit.visual, true),
    ...matrix(study, phase, study.audit.diagnostics),
  ];
  else if (phase === "test") assignments = [
    ...matrix(study, phase, study.headline.pairwise), ...matrix(study, phase, study.headline.dense),
  ];
  else if (phase === "ablation") {
    const base = study.methods.riemannian as Record<string, unknown>;
    const baseParameters = base.parameters as Record<string, number>;
    assignments = study.ablations.scenarioTypes.flatMap((scenarioType) => study.ablations.seeds.flatMap((seed) =>
      Object.entries(study.ablations.variants).map(([ablation, variant]) => ({
        phase, scenarioType, seed, method: "riemannian", ablation,
        scenario: requireScenario(study, scenarioType), outputRoot: study.outputs.root,
        methodConfig: {
          ablationMethodConfigVersion: 1, id: "riemannian_ablation_v1",
          engine: "scientific_core_ablation_engine_v1", velocityTimeConstant: base.velocityTimeConstant,
          parameters: { ...baseParameters, lambdaR: variant.lambdaR, lambdaT: variant.lambdaT },
          gates: { closing: variant.closing, visibility: variant.visibility },
        },
      }))));
  } else {
    const source = requireScenario(study, study.runtime.scenario);
    const cells = study.runtime.agentCounts.flatMap((agentCount) => [
      ...Array.from({ length: study.runtime.warmups }, (_, repetition) => ({ agentCount, repetition, warmup: true })),
      ...Array.from({ length: study.runtime.measuredRepetitions }, (_, repetition) => ({ agentCount, repetition, warmup: false })),
    ]);
    assignments = cells.flatMap(({ agentCount, repetition, warmup }) => Object.entries(study.methods)
      .map(([method, methodConfig]) => ({
        phase, scenarioType: `circle-n${agentCount}-${warmup ? "warmup" : "measured"}-${repetition}`,
        seed: study.runtime.seed, method, scenario: { ...source, agentCount }, methodConfig,
        outputRoot: study.outputs.root, repetition, warmup,
      })));
  }
  assertUniqueAssignments(assignments);
  return assignments.sort((a, b) => runKey(a).localeCompare(runKey(b)));
}

export function buildBenchmarkAssignments(study: LeanStudy): Assignment[] {
  const assignments = matrix(study, "benchmark", study.benchmark);
  assertUniqueAssignments(assignments);
  return assignments.sort((a, b) => runKey(a).localeCompare(runKey(b)));
}

export function runKey(assignment: Assignment): string {
  return `${assignment.phase}/${assignment.scenarioType}/${assignment.seed}/${assignment.ablation ?? assignment.method}`;
}

export function assignmentIdentity(assignment: Assignment): unknown {
  return {
    scenario: assignment.scenario, methodConfig: assignment.methodConfig,
    ablation: assignment.ablation ?? null, repetition: assignment.repetition ?? null,
    warmup: assignment.warmup ?? null, visual: assignment.visual ?? false,
  };
}

export function assertUniqueAssignments(assignments: readonly Assignment[]): void {
  const keys = new Set<string>();
  for (const assignment of assignments) {
    const key = runKey(assignment);
    if (keys.has(key)) throw new Error(`Duplicate lean run key: ${key}`);
    keys.add(key);
  }
}

export function pendingAssignments(assignments: readonly Assignment[], records: Map<string, RunRecord>, resume: boolean): Assignment[] {
  return assignments.filter((assignment) => {
    const key = runKey(assignment); const existing = records.get(key);
    if (existing === undefined) return true;
    if (JSON.stringify(existing.assignmentIdentity) !== JSON.stringify(assignmentIdentity(assignment))) {
      throw new Error(`Assignment identity changed for ${key}`);
    }
    if (!resume) throw new Error(`Existing result for ${key}; use --resume`);
    return existing.status !== "PASS";
  });
}

export function requireHumanReviewGate(path: string): void {
  if (!existsSync(path) || readFileSync(path, "utf8").trim().length === 0) {
    throw new Error(`Human visual review is required: create nonempty ${path}`);
  }
}

export function validateWorkerRecord(value: unknown): RunRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Worker output must be an object");
  const record = value as RunRecord;
  if (typeof record.key !== "string" || !["PASS", "FAIL"].includes(record.status)) throw new Error("Malformed worker record");
  assertFinite(value, "worker");
  return record;
}

export async function runPool(assignments: readonly Assignment[], jobs: number, onRecord: (record: RunRecord) => void = () => {}): Promise<RunRecord[]> {
  if (!Number.isSafeInteger(jobs) || jobs < 1) throw new Error("--jobs must be a positive integer");
  const queue = [...assignments]; const results: RunRecord[] = [];
  return await new Promise((resolvePromise, reject) => {
    let active = 0; let stopped = false;
    const launch = () => {
      if (stopped) return;
      if (queue.length === 0 && active === 0) return resolvePromise(results.sort((a, b) => a.key.localeCompare(b.key)));
      while (active < jobs && queue.length > 0) {
        const assignment = queue.shift() as Assignment; active += 1;
        const child = spawn(process.execPath, ["--import", "tsx", resolve("experiments/lean/worker.ts"), JSON.stringify(assignment)], {
          cwd: resolve("."), stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = ""; let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += String(chunk); });
        child.stderr.on("data", (chunk) => { stderr += String(chunk); });
        child.on("error", (error) => { stderr += error.message; });
        child.on("close", () => {
          active -= 1;
          try {
            const record = validateWorkerRecord(JSON.parse(stdout.trim()) as unknown);
            if (record.key !== runKey(assignment)) throw new Error(`Worker returned wrong key for ${runKey(assignment)}`);
            results.push(record); onRecord(record);
          } catch (error) {
            stopped = true;
            reject(new Error(`Worker protocol failure for ${runKey(assignment)}: ${error instanceof Error ? error.message : error}\n${stderr.trim()}`));
            return;
          }
          launch();
        });
      }
    };
    launch();
  });
}

function readRecords(path: string): Map<string, RunRecord> {
  const records = new Map<string, RunRecord>();
  if (!existsSync(path)) return records;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/u).filter(Boolean)) {
    const record = validateWorkerRecord(JSON.parse(line) as unknown);
    if (records.has(record.key)) throw new Error(`Duplicate raw run key: ${record.key}`);
    records.set(record.key, record);
  }
  return records;
}

function checkpoint(path: string, records: Map<string, RunRecord>): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, [...records.values()].sort((a, b) => a.key.localeCompare(b.key)).map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  renameSync(temporary, path);
}

async function benchmark(study: LeanStudy): Promise<number> {
  const assignments = buildBenchmarkAssignments(study); let reference = "";
  const timings: Array<{ jobs: number; wallSeconds: number }> = [];
  for (const jobs of study.benchmark.jobs) {
    const start = performance.now(); const records = await runPool(assignments, jobs);
    if (records.some((record) => record.status !== "PASS")) throw new Error(`Benchmark jobs=${jobs} had a failed run`);
    const normalized = JSON.stringify(records.map(({ runtimeSeconds: _runtime, ...record }) => record));
    if (reference !== "" && normalized !== reference) throw new Error(`Non-runtime benchmark output differs for jobs=${jobs}`);
    reference = normalized; timings.push({ jobs, wallSeconds: (performance.now() - start) / 1000 });
  }
  const fastest = [...timings].sort((a, b) => a.wallSeconds - b.wallSeconds)[0].jobs;
  mkdirSync(resolve(study.outputs.benchmark, ".."), { recursive: true });
  writeFileSync(study.outputs.benchmark, `${JSON.stringify({ status: "PASS", assignmentCount: assignments.length, equality: true, timings, fastestJobs: fastest }, null, 2)}\n`);
  return fastest;
}

async function runPhase(study: LeanStudy, phase: "audit" | "test" | "ablation" | "runtime", jobs: number, resume: boolean): Promise<void> {
  const records = readRecords(study.outputs.raw); const assignments = buildAssignments(study, phase);
  const pending = pendingAssignments(assignments, records, resume);
  await runPool(pending, jobs, (record) => { records.set(record.key, record); checkpoint(study.outputs.raw, records); });
  const selected = assignments.map((assignment) => records.get(runKey(assignment))).filter(Boolean) as RunRecord[];
  console.log(`${phase}: ${selected.filter((row) => row.status === "PASS").length} PASS, ${selected.filter((row) => row.status === "FAIL").length} FAIL, ${assignments.length - pending.length} resumed`);
  if (selected.some((row) => row.status === "FAIL")) throw new Error(`${phase} contains failed assignments`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2); const phase = option(args, "--phase") ?? "";
  const jobs = Number(option(args, "--jobs") ?? "1"); const resume = args.includes("--resume");
  const study = loadStudy();
  if (phase === "analyze") {
    const python = process.platform === "win32" ? "python" : "python3";
    const result = spawnSync(python, [resolve("experiments/lean/analyze.py")], { stdio: "inherit" });
    if (result.status !== 0) throw new Error(`Lean analysis failed with exit ${result.status}`);
    return;
  }
  if (!["audit", "test", "ablation", "runtime"].includes(phase)) throw new Error(`Unsupported --phase ${phase}`);
  if (!Number.isSafeInteger(jobs) || jobs < 1) throw new Error("--jobs must be a positive integer");
  if (phase === "runtime" && jobs !== 1) throw new Error("Runtime phase requires --jobs 1");
  if (phase !== "audit") requireHumanReviewGate(study.humanReviewGate);
  const selectedJobs = phase === "audit" ? await benchmark(study) : jobs;
  await runPhase(study, phase as "audit" | "test" | "ablation" | "runtime", selectedJobs, resume);
  if (phase === "audit") {
    const packaged = spawnSync(process.execPath, ["--import", "tsx", resolve("experiments/lean/worker.ts"), "--package-viewer", study.outputs.auditRoot], { encoding: "utf8" });
    if (packaged.status !== 0) throw new Error(`Viewer packaging failed: ${packaged.stderr.trim()}`);
    console.log(`viewer packaging: ${packaged.stdout.trim()}`);
    const result = generateReviewIndex({ auditRoot: study.outputs.auditRoot, outputDirectory: resolve(study.outputs.auditRoot, "viewer") });
    console.log(`viewer: ${result.runCount} runs across ${result.scenarioCount} scenarios at ${result.indexPath}`);
  }
}

function requireScenario(study: LeanStudy, name: string): ScenarioSpec {
  const scenario = study.scenarios[name]; if (scenario === undefined) throw new Error(`Unknown scenario ${name}`); return scenario;
}
function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name); if (index < 0) return undefined;
  const value = args[index + 1]; if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`); return value;
}
function assertFinite(value: unknown, path: string): void {
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`${path} is non-finite`);
  if (Array.isArray(value)) value.forEach((entry, index) => assertFinite(entry, `${path}[${index}]`));
  else if (value !== null && typeof value === "object") Object.entries(value).forEach(([key, entry]) => assertFinite(entry, `${path}.${key}`));
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href)
  main().catch((error) => { console.error(`lean failed: ${error instanceof Error ? error.message : error}`); process.exitCode = 1; });
