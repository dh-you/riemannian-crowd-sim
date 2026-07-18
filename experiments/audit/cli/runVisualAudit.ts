import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { generateBidirectionalScenario } from "../../generation/bidirectional";
import { generateBottleneckScenario } from "../../generation/bottleneck";
import { generateCircleAntipodalScenario } from "../../generation/circleAntipodal";
import { identifyMethod } from "../../protocol/methodIdentity";
import { parseMethodConfig } from "../../protocol/methodConfig";
import { serializeExperimentScenario } from "../../protocol/schema";
import { AUDIT_RESULTS_ROOT, runPython, writeJson } from "./auditUtils";
import { runAuditedEngine } from "./auditRun";
import { runGoldAudit } from "./runGoldAudit";

const METHODS = [
  "experiments/methods/riemannian-default.json",
  "experiments/methods/goal-projection.json",
  "experiments/methods/orca-default.json",
  "experiments/methods/social-force-default.json",
] as const;

export interface VisualAuditResult {
  status: "PENDING HUMAN REVIEW";
  svgCount: number;
  checklistPath: string;
  reportPath: string;
}

export function runVisualAudit(): VisualAuditResult {
  let goldSvgPaths: string[];
  try {
    goldSvgPaths = runGoldAudit().svgPaths;
  } catch (error) {
    const goldRoot = resolve(AUDIT_RESULTS_ROOT, "gold");
    if (!existsSync(resolve(goldRoot, "report.json"))) throw error;
    goldSvgPaths = findNamedFiles(goldRoot, "trajectory.svg");
    console.warn(`Gold expectations contain a preserved failure; visual packet will still be generated: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = resolve(AUDIT_RESULTS_ROOT, "visuals");
  const scenarioRoot = resolve(root, "scenarios");
  mkdirSync(scenarioRoot, { recursive: true });
  const smallScenarios = [
    generateCircleAntipodalScenario("audit", 0, 8),
    generateBidirectionalScenario("audit", 0, 12),
    generateBottleneckScenario("audit", 0, 16),
  ].map((scenario) => ({ ...scenario, simulation: { ...scenario.simulation, horizonSeconds: 2 } }));
  const svgPaths = [...goldSvgPaths];
  for (const scenario of smallScenarios) {
    const scenarioPath = resolve(scenarioRoot, `${scenario.name}.json`);
    writeFileSync(scenarioPath, serializeExperimentScenario(scenario), "utf8");
    for (const methodPath of METHODS) {
      const source = readFileSync(methodPath, "utf8");
      const method = parseMethodConfig(JSON.parse(source) as unknown);
      const identity = identifyMethod(method, source);
      const outputRoot = resolve(root, "runs", scenario.name, identity.methodKey);
      const run = runAuditedEngine(scenarioPath, methodPath, outputRoot);
      const svgPath = resolve(outputRoot, "trajectory.svg");
      runPython("experiments/audit/python/render_trajectory_svg.py", ["--scenario", scenarioPath, "--trajectory", run.trajectoryPath, "--out", svgPath, "--method", method.id]);
      svgPaths.push(svgPath);
    }
  }
  const checklistPath = resolve(AUDIT_RESULTS_ROOT, "visual-checklist.md");
  const rows = svgPaths.map((path) => [
    `### ${relative(AUDIT_RESULTS_ROOT, path).replaceAll("\\", "/")}`,
    "",
    `- Artifact: [SVG](${relative(AUDIT_RESULTS_ROOT, path).replaceAll("\\", "/")})`,
    "- [ ] no teleportation",
    "- [ ] goals and starting positions are correct",
    "- [ ] no unexplained wall crossing",
    "- [ ] closest encounter marker matches the paths",
    "- [ ] pre/post projection distinction is visible",
    "- [ ] arrival behavior is coherent",
    "- [ ] no extreme oscillation hidden by aggregate metrics",
    "",
  ].join("\n"));
  writeFileSync(checklistPath, ["# Stage D0 visual checklist", "", "Status: **PENDING HUMAN REVIEW**", "", "Automated generation does not approve these artifacts. A human reviewer must inspect and check each item.", "", ...rows].join("\n"), "utf8");
  const reportPath = resolve(root, "report.json");
  writeJson(reportPath, { visualAuditVersion: 1, status: "PENDING HUMAN REVIEW", svgCount: svgPaths.length, checklistPath, svgPaths });
  return { status: "PENDING HUMAN REVIEW", svgCount: svgPaths.length, checklistPath, reportPath };
}

function findNamedFiles(directory: string, name: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return findNamedFiles(path, name);
    return entry.name === name ? [path] : [];
  }).sort();
}

function main(): void {
  try {
    const result = runVisualAudit();
    console.log(`audit:visuals generated ${result.svgCount} SVGs; status is ${result.status}`);
  } catch (error) {
    console.error(`audit:visuals failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) main();
