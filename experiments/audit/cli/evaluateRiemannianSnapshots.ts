import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RiemannianController, riemannianSpeed } from "../../../src/core/RiemannianController";
import type { AgentState, Mat2 } from "../../../src/core/types";
import { validateAgentStates, validateControllerParameters } from "../../../src/core/validation";
import { forEachJsonLineSync } from "../../protocol/jsonLines";

interface Snapshot {
  caseId: string;
  parameters: { alpha: number; sigma: number; lambdaR: number; lambdaT: number };
  goalTolerance: number;
  controlled: AgentState;
  neighbors: AgentState[];
  expectFreeSpace?: boolean;
  expectSeparatingEqualsFreeSpace?: boolean;
}

export function parseSnapshot(value: unknown, line: number): Snapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Snapshot line ${line} must be an object`);
  }
  const root = value as Record<string, unknown>;
  const allowed = new Set(["caseId", "parameters", "goalTolerance", "controlled", "neighbors", "expectFreeSpace", "expectSeparatingEqualsFreeSpace"]);
  for (const key of Object.keys(root)) if (!allowed.has(key)) throw new Error(`Snapshot line ${line}.${key} is not allowed`);
  if (typeof root.caseId !== "string" || root.caseId.length === 0) throw new Error(`Snapshot line ${line} needs caseId`);
  if (root.parameters === null || typeof root.parameters !== "object" || Array.isArray(root.parameters)) throw new Error(`Snapshot line ${line} needs parameters`);
  const parameters = root.parameters as Snapshot["parameters"];
  validateControllerParameters({ id: "conditioned_riemannian_metric_v1", ...parameters });
  if (typeof root.goalTolerance !== "number" || !Number.isFinite(root.goalTolerance) || root.goalTolerance < 0) throw new Error(`Snapshot line ${line} has invalid goalTolerance`);
  if (root.controlled === null || typeof root.controlled !== "object" || Array.isArray(root.controlled)) throw new Error(`Snapshot line ${line} needs controlled agent`);
  if (!Array.isArray(root.neighbors)) throw new Error(`Snapshot line ${line} needs neighbors`);
  const controlled = root.controlled as AgentState;
  const neighbors = root.neighbors as AgentState[];
  validateAgentStates([controlled, ...neighbors]);
  for (const flag of ["expectFreeSpace", "expectSeparatingEqualsFreeSpace"] as const) {
    if (root[flag] !== undefined && typeof root[flag] !== "boolean") throw new Error(`Snapshot line ${line}.${flag} must be boolean`);
  }
  return root as unknown as Snapshot;
}

function eigenvalues(metric: Mat2): readonly [number, number] {
  const trace = metric.xx + metric.yy;
  const discriminant = Math.hypot(metric.xx - metric.yy, 2 * metric.xy);
  return [(trace - discriminant) / 2, (trace + discriminant) / 2];
}

export function evaluateSnapshots(inputPath: string, outputPath: string): number {
  mkdirSync(dirname(resolve(outputPath)), { recursive: true });
  const descriptor = openSync(resolve(outputPath), "w");
  let count = 0;
  try {
    forEachJsonLineSync(resolve(inputPath), (line, index) => {
      const snapshot = parseSnapshot(JSON.parse(line) as unknown, index + 1);
      const controller = new RiemannianController({ id: "conditioned_riemannian_metric_v1", ...snapshot.parameters });
      const effective = controller.computeEffectiveMetric(snapshot.controlled, snapshot.neighbors);
      const target = controller.computeTargetVelocity(snapshot.controlled, effective.metric, snapshot.goalTolerance);
      const output = {
        caseId: snapshot.caseId,
        metric: [[effective.metric.xx, effective.metric.xy], [effective.metric.yx, effective.metric.yy]],
        targetVelocity: target.targetVelocity,
        arrived: target.arrived,
        coincidentNeighborContributionsSkipped: effective.coincidentNeighborContributionsSkipped,
        eigenvalues: eigenvalues(effective.metric),
        riemannianSpeed: riemannianSpeed(target.targetVelocity, effective.metric),
        symmetryResidual: Math.abs(effective.metric.xy - effective.metric.yx),
      };
      writeFileSync(descriptor, `${JSON.stringify(output)}\n`, "utf8");
      count += 1;
    });
  } finally {
    closeSync(descriptor);
  }
  return count;
}

function main(): void {
  const inputPath = process.argv[2];
  const outputPath = process.argv[3];
  if (inputPath === undefined || outputPath === undefined) throw new Error("Usage: evaluateRiemannianSnapshots <input.jsonl> <output.jsonl>");
  console.log(`production Riemannian evaluator wrote ${evaluateSnapshots(inputPath, outputPath)} cases`);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) main();
