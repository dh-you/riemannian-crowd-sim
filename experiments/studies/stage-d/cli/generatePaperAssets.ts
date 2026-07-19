import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { TrajectoryRecord } from "../../../output/types";
import { forEachJsonLineSync } from "../../../protocol/jsonLines";
import { sha256File } from "../../../protocol/hash";
import { FREEZE_MANIFEST_PATH, type FreezeManifest } from "./freezeConfigurations";
import {
  PAPER_ROOT,
  RESULTS_ROOT,
  currentGitHead,
  phaseManifestPath,
  readJson,
  writeJson,
} from "../studyPaths";

interface MainRow {
  methodId: string;
  methodKey: string;
  metric: string;
  unit: string;
  estimate: number | null;
  confidenceLower: number | null;
  confidenceUpper: number | null;
  contributingScenarios: number;
}

const LABELS: Record<string, string> = {
  conditioned_riemannian_metric_v1: "Conditioned Riemannian",
  euclidean_goal_steering_v1: "Goal+Projection",
  orca_rvo2_v1: "ORCA/RVO2",
  social_force_pysocialforce_v1: "PySocialForce",
};

const MAIN_METRICS = [
  ["success_fraction", "Success", "fraction"],
  ["normalized_travel_time", "Normalized travel time", "ratio; successful arrivals"],
  ["pre_correction_overlap_exposure", "Raw overlap exposure", "pair-s / agent-s"],
  ["maximum_pre_correction_penetration", "Maximum raw penetration", "m"],
  ["rms_acceleration", "RMS acceleration", "m/s²"],
  ["correction_ratio", "Correction ratio", "ratio"],
] as const;

export function generatePaperAssets(): { fileCount: number; claimsPath: string } {
  const analysis = readJson<{ status?: string }>(phaseManifestPath("analysis"));
  const runtime = readJson<{ status?: string }>(phaseManifestPath("runtime"));
  if (analysis.status !== "PASS" || runtime.status !== "PASS") {
    throw new Error("Passing analysis and runtime manifests are required for paper assets");
  }
  const freeze = readJson<FreezeManifest>(FREEZE_MANIFEST_PATH);
  const compactRoot = resolve(RESULTS_ROOT, "compact");
  const dataRoot = resolve(PAPER_ROOT, "data");
  const tableRoot = resolve(PAPER_ROOT, "tables");
  const figureRoot = resolve(PAPER_ROOT, "figures");
  for (const root of [dataRoot, tableRoot, figureRoot]) mkdirSync(root, { recursive: true });
  const dataFiles = [
    "main-results.csv",
    "main-results.json",
    "per-family-results.csv",
    "paired-differences.csv",
    "validation-selection.csv",
    "ablation-results.csv",
    "sensitivity-results.csv",
    "runtime-results.csv",
    "failure-summary.csv",
  ];
  for (const name of dataFiles) copyFileSync(resolve(compactRoot, name), resolve(dataRoot, name));
  const manifestRoot = resolve(dataRoot, "manifests");
  mkdirSync(manifestRoot, { recursive: true });
  const manifestSources = [
    [resolve(RESULTS_ROOT, "candidates/manifest.json"), "candidate-manifest.json"],
    [phaseManifestPath("screening"), "screening-manifest.json"],
    [phaseManifestPath("validation-tuning"), "validation-tuning-manifest.json"],
    [phaseManifestPath("validation-holdout"), "validation-holdout-manifest.json"],
    [phaseManifestPath("selection"), "selection-manifest.json"],
    [phaseManifestPath("ablations"), "ablation-manifest.json"],
    [resolve(RESULTS_ROOT, "test/merged-test-manifest.json"), "merged-test-manifest.json"],
    [phaseManifestPath("runtime"), "runtime-manifest.json"],
    [phaseManifestPath("analysis"), "analysis-manifest.json"],
  ] as const;
  for (const [source, name] of manifestSources) copyFileSync(source, resolve(manifestRoot, name));
  const main = readJson<{ mainResults: MainRow[]; pairedDifferences: unknown[] }>(
    resolve(compactRoot, "main-results.json"),
  );
  writeMainTables(tableRoot, main.mainResults);
  writePairwiseTable(tableRoot, main.mainResults);
  writeMainFigure(resolve(figureRoot, "main-comparison.svg"), main.mainResults, resolve(dataRoot, "main-results.csv"));
  writeAblationSensitivityFigure(
    resolve(figureRoot, "ablation-sensitivity.svg"),
    resolve(dataRoot, "ablation-results.csv"),
    resolve(dataRoot, "sensitivity-results.csv"),
  );
  writeRuntimeFigure(resolve(figureRoot, "runtime-scaling.svg"), resolve(dataRoot, "runtime-results.csv"));
  writePairwiseTrajectories(
    resolve(figureRoot, "pairwise-trajectories.svg"),
    resolve(dataRoot, "pairwise-trajectories.csv"),
    freeze,
  );
  const claimsPath = resolve(PAPER_ROOT, "claims-audit.md");
  writeClaimsAudit(claimsPath, main.mainResults, resolve(dataRoot, "ablation-results.csv"));
  writeFileSync(resolve(PAPER_ROOT, "README.md"), [
    "# Stage D paper assets",
    "",
    "These files are generated from the frozen Stage D test, validation-only ablation/sensitivity, and runtime manifests.",
    "They are compact evidence for human interpretation, not a claim that the paper is complete.",
    "",
    `- Repository commit used for generation: \`${currentGitHead()}\``,
    `- Freeze manifest SHA-256: \`${sha256File(FREEZE_MANIFEST_PATH)}\``,
    "- Normalized travel time is conditional on successful arrivals.",
    "- Safety columns use pre-correction agent-agent quantities; correction dependence is separate.",
    "- ORCA and PySocialForce retain native-none correction semantics.",
    "- Figures use preregistered test seed 1000 for shown pairwise trajectories.",
    "",
  ].join("\n"), "utf8");
  const files = [
    ...dataFiles.map((name) => resolve(dataRoot, name)),
    ...manifestSources.map(([, name]) => resolve(manifestRoot, name)),
    resolve(dataRoot, "pairwise-trajectories.csv"),
    resolve(tableRoot, "main-comparison.md"),
    resolve(tableRoot, "main-comparison.tex"),
    resolve(tableRoot, "pairwise-anticipation.md"),
    resolve(figureRoot, "main-comparison.svg"),
    resolve(figureRoot, "ablation-sensitivity.svg"),
    resolve(figureRoot, "pairwise-trajectories.svg"),
    resolve(figureRoot, "runtime-scaling.svg"),
    claimsPath,
    resolve(PAPER_ROOT, "README.md"),
  ];
  writeJson(phaseManifestPath("paper"), {
    paperAssetManifestVersion: 1,
    status: "PASS",
    repositoryCommit: currentGitHead(),
    freezeManifestSha256: sha256File(FREEZE_MANIFEST_PATH),
    files: files.map((path) => ({ path, sha256: sha256File(path) })),
  });
  return { fileCount: files.length, claimsPath };
}

function writeMainTables(root: string, rows: readonly MainRow[]): void {
  const methods = Object.keys(LABELS);
  const header = ["Method", ...MAIN_METRICS.map(([, label]) => label), "Bottleneck throughput"];
  const markdown = [
    "# Frozen Stage D headline comparison",
    "",
    "Point estimate [bootstrap 95% CI]. Normalized travel time is conditional on success.",
    "",
    `| ${header.join(" | ")} |`,
    `|${header.map(() => "---").join("|")}|`,
    ...methods.map((methodId) => `| ${[
      LABELS[methodId],
      ...MAIN_METRICS.map(([metric]) => formatCell(findRow(rows, methodId, metric))),
      formatCell(findRow(rows, methodId, "throughput")),
    ].join(" | ")} |`),
    "",
  ];
  writeFileSync(resolve(root, "main-comparison.md"), markdown.join("\n"), "utf8");
  const latex = [
    "% Generated Stage D table; normalized travel time is conditional on success.",
    "\\begin{tabular}{lrrrrrrr}",
    "\\toprule",
    "Method & Success & Travel & Overlap & Penetration & Accel. & Correction & Throughput \\\\",
    "\\midrule",
    ...methods.map((methodId) => [
      escapeLatex(LABELS[methodId]),
      ...MAIN_METRICS.map(([metric]) => formatCell(findRow(rows, methodId, metric))),
      formatCell(findRow(rows, methodId, "throughput")),
    ].join(" & ") + " \\\\"),
    "\\bottomrule",
    "\\end{tabular}",
    "",
  ];
  writeFileSync(resolve(root, "main-comparison.tex"), latex.join("\n"), "utf8");
}

function writePairwiseTable(root: string, rows: readonly MainRow[]): void {
  const metrics = [
    ["avoidance_onset_rate", "Avoidance-onset rate"],
    ["ttc_at_onset", "TTC at onset (s)"],
    ["minimum_pre_correction_physical_clearance", "Minimum pre-correction clearance (m)"],
    ["minimum_post_correction_physical_clearance", "Minimum post-correction clearance (m)"],
  ] as const;
  const lines = [
    "# Pairwise anticipation and separation",
    "",
    "Point estimate [bootstrap 95% CI] on the complete pairwise frozen test subset.",
    "",
    `| Method | ${metrics.map(([, label]) => label).join(" | ")} |`,
    `|---|${metrics.map(() => "---:").join("|")}|`,
    ...Object.keys(LABELS).map((methodId) => `| ${LABELS[methodId]} | ${metrics
      .map(([metric]) => formatCell(findRow(rows, methodId, metric))).join(" | ")} |`),
    "",
  ];
  writeFileSync(resolve(root, "pairwise-anticipation.md"), lines.join("\n"), "utf8");
}

function writeMainFigure(path: string, rows: readonly MainRow[], sourcePath: string): void {
  const methods = Object.keys(LABELS);
  const width = 960;
  const height = 620;
  const panels: string[] = [];
  MAIN_METRICS.forEach(([metric, title, unit], panelIndex) => {
    const values = methods.map((methodId) => findRow(rows, methodId, metric));
    const maximum = Math.max(1e-12, ...values.flatMap((row) =>
      [row?.estimate ?? 0, row?.confidenceUpper ?? 0]));
    const column = panelIndex % 3;
    const rowIndex = Math.floor(panelIndex / 3);
    const x = 28 + column * 310;
    const y = 35 + rowIndex * 290;
    panels.push(`<text x="${x + 135}" y="${y}" text-anchor="middle" class="title">${escapeXml(title)}</text>`);
    panels.push(`<text x="${x + 135}" y="${y + 16}" text-anchor="middle" class="unit">${escapeXml(unit)}</text>`);
    panels.push(`<line x1="${x + 42}" y1="${y + 238}" x2="${x + 285}" y2="${y + 238}" class="axis"/>`);
    values.forEach((value, methodIndex) => {
      if (value?.estimate === null || value?.estimate === undefined) return;
      const barX = x + 52 + methodIndex * 58;
      const barHeight = 180 * value.estimate / maximum;
      const top = y + 238 - barHeight;
      panels.push(`<rect x="${barX}" y="${top}" width="34" height="${barHeight}" class="m${methodIndex}"/>`);
      if (value.confidenceLower !== null && value.confidenceUpper !== null) {
        const low = y + 238 - 180 * value.confidenceLower / maximum;
        const high = y + 238 - 180 * value.confidenceUpper / maximum;
        panels.push(`<line x1="${barX + 17}" y1="${low}" x2="${barX + 17}" y2="${high}" class="ci"/>`);
      }
      panels.push(`<text x="${barX + 17}" y="${y + 254}" text-anchor="middle" class="method">${methodIndex + 1}</text>`);
    });
    panels.push(`<text x="${x + 38}" y="${y + 238}" text-anchor="end" class="tick">0</text>`);
    panels.push(`<text x="${x + 38}" y="${y + 60}" text-anchor="end" class="tick">${format(maximum)}</text>`);
  });
  const legend = methods.map((methodId, index) =>
    `<text x="${35 + index * 225}" y="608" class="legend">${index + 1}. ${escapeXml(LABELS[methodId])}</text>`).join("");
  writeFileSync(path, svgDocument(width, height, sha256File(sourcePath), panels.join("") + legend), "utf8");
}

function writeAblationSensitivityFigure(path: string, ablationPath: string, sensitivityPath: string): void {
  const ablations = readCsv(ablationPath).filter((row) => row.metric === "pre_correction_overlap_exposure");
  const sensitivity = readCsv(sensitivityPath);
  const body: string[] = [
    '<text x="240" y="28" text-anchor="middle" class="title">Validation-holdout ablations: raw overlap exposure</text>',
    '<line x1="55" y1="350" x2="455" y2="350" class="axis"/>',
  ];
  const maxAblation = Math.max(1e-12, ...ablations.map((row) => Number(row.estimate)));
  ablations.forEach((row, index) => {
    const x = 70 + index * 63;
    const value = Number(row.estimate);
    const barHeight = 270 * value / maxAblation;
    body.push(`<rect x="${x}" y="${350 - barHeight}" width="38" height="${barHeight}" class="m${index % 4}"/>`);
    body.push(`<text x="${x + 19}" y="370" text-anchor="end" transform="rotate(-35 ${x + 19} 370)" class="method">${escapeXml(row.ablation)}</text>`);
  });
  body.push('<text x="720" y="28" text-anchor="middle" class="title">Preregistered one-at-a-time sensitivity</text>');
  body.push('<text x="720" y="46" text-anchor="middle" class="unit">macro maximum penetration (m), screening validation</text>');
  const axes = ["alpha", "sigma", "rho", "velocityTimeConstant"];
  axes.forEach((axis, axisIndex) => {
    const rows = sensitivity.filter((row) => row.axis === axis && row.status === "VALID");
    const yBase = 105 + axisIndex * 105;
    const maximum = Math.max(1e-12, ...rows.map((row) => Number(row.macroMaximumPenetration)));
    body.push(`<text x="510" y="${yBase}" class="legend">${escapeXml(axis)}</text>`);
    rows.forEach((row, index) => {
      const x = 620 + index * 115;
      const height = 62 * Number(row.macroMaximumPenetration) / maximum;
      body.push(`<rect x="${x}" y="${yBase + 55 - height}" width="45" height="${height}" class="m${index}"/>`);
      body.push(`<text x="${x + 22}" y="${yBase + 70}" text-anchor="middle" class="method">${index + 1}</text>`);
    });
  });
  writeFileSync(path, svgDocument(960, 520, `${sha256File(ablationPath)} ${sha256File(sensitivityPath)}`, body.join("")), "utf8");
}

function writeRuntimeFigure(path: string, runtimePath: string): void {
  const rows = readCsv(runtimePath);
  const methods = Object.keys(LABELS);
  const maximum = Math.max(...rows.map((row) => Number(row.median_wall_clock_seconds)));
  const body = [
    '<text x="450" y="28" text-anchor="middle" class="title">End-to-end runtime scaling</text>',
    '<text x="450" y="46" text-anchor="middle" class="unit">median wall-clock seconds; five sequential repetitions</text>',
    '<line x1="75" y1="430" x2="850" y2="430" class="axis"/>',
    '<line x1="75" y1="70" x2="75" y2="430" class="axis"/>',
  ];
  methods.forEach((methodId, methodIndex) => {
    const methodRows = rows.filter((row) => row.method_id === methodId)
      .sort((first, second) => Number(first.population) - Number(second.population));
    const points = methodRows.map((row) => {
      const x = 75 + (Number(row.population) - 50) / 150 * 775;
      const y = 430 - Number(row.median_wall_clock_seconds) / Math.max(maximum, 1e-12) * 340;
      return [x, y] as const;
    });
    body.push(`<polyline points="${points.map(([x, y]) => `${x},${y}`).join(" ")}" class="line${methodIndex}"/>`);
    points.forEach(([x, y]) => body.push(`<circle cx="${x}" cy="${y}" r="5" class="point${methodIndex}"/>`));
    body.push(`<text x="${110 + methodIndex * 200}" y="475" class="legend">${methodIndex + 1}. ${escapeXml(LABELS[methodId])}</text>`);
  });
  [50, 100, 200].forEach((population) => {
    const x = 75 + (population - 50) / 150 * 775;
    body.push(`<text x="${x}" y="448" text-anchor="middle" class="tick">${population}</text>`);
  });
  body.push('<text x="450" y="505" text-anchor="middle" class="unit">Population N</text>');
  body.push(`<text x="65" y="75" text-anchor="end" class="tick">${format(maximum)} s</text>`);
  body.push('<text x="65" y="430" text-anchor="end" class="tick">0</text>');
  writeFileSync(path, svgDocument(900, 525, sha256File(runtimePath), body.join("")), "utf8");
}

function writePairwiseTrajectories(path: string, dataPath: string, freeze: FreezeManifest): void {
  const variants = ["head_on", "crossing"];
  const methods = [...freeze.frozenMethods].sort((first, second) => first.methodId.localeCompare(second.methodId));
  const csv = ["variant,seed,method_id,method_key,agent_id,step_index,time,x_m,y_m"];
  const panels: string[] = [];
  variants.forEach((variant, rowIndex) => {
    const scenario = freeze.testScenarios.find((entry) =>
      entry.family === "pairwise" && entry.variant === variant && entry.seed === 1000);
    if (scenario === undefined) throw new Error(`Representative trajectory scenario missing: ${variant}`);
    const scenarioValue = JSON.parse(readFileSync(scenario.path, "utf8")) as {
      agents: Array<{ id: number; position: [number, number]; goal: [number, number] }>;
    };
    methods.forEach((method, columnIndex) => {
      const trajectoryPath = resolve(RESULTS_ROOT, "test/runs", scenario.scenarioId, method.methodKey, "trajectory.jsonl");
      const byAgent = new Map<number, Array<[number, number]>>(
        scenarioValue.agents.map((agent) => [agent.id, [agent.position]]),
      );
      let recordCount = 0;
      forEachJsonLineSync(trajectoryPath, (line) => {
        const record = JSON.parse(line) as TrajectoryRecord;
        recordCount += 1;
        for (const agent of record.agents) {
          byAgent.get(agent.id)?.push([agent.position[0], agent.position[1]]);
          csv.push([variant, 1000, method.methodId, method.methodKey, agent.id, record.stepIndex, record.time, agent.position[0], agent.position[1]].join(","));
        }
      });
      if (recordCount < 2) throw new Error(`Representative trajectory was not recorded every step: ${variant}/${method.methodId}`);
      const x0 = 20 + columnIndex * 230;
      const y0 = 40 + rowIndex * 240;
      const all = [...byAgent.values()].flat();
      const minX = Math.min(...all.map(([x]) => x));
      const maxX = Math.max(...all.map(([x]) => x));
      const minY = Math.min(...all.map(([, y]) => y));
      const maxY = Math.max(...all.map(([, y]) => y));
      const scale = Math.min(190 / Math.max(maxX - minX, 1), 155 / Math.max(maxY - minY, 1));
      const map = ([x, y]: [number, number]) => [x0 + 20 + (x - minX) * scale, y0 + 185 - (y - minY) * scale] as const;
      panels.push(`<text x="${x0 + 105}" y="${y0}" text-anchor="middle" class="title">${escapeXml(LABELS[method.methodId])}</text>`);
      if (columnIndex === 0) panels.push(`<text x="${x0}" y="${y0 + 18}" class="unit">${variant}, seed 1000</text>`);
      for (const [agentId, points] of byAgent) {
        panels.push(`<polyline points="${points.map((point) => map(point).join(",")).join(" ")}" class="line${agentId % 4}"/>`);
      }
      for (const agent of scenarioValue.agents) {
        const goal = map(agent.goal);
        panels.push(`<path d="M${goal[0] - 4},${goal[1] - 4} L${goal[0] + 4},${goal[1] + 4} M${goal[0] + 4},${goal[1] - 4} L${goal[0] - 4},${goal[1] + 4}" class="axis"/>`);
      }
    });
  });
  writeFileSync(dataPath, `${csv.join("\n")}\n`, "utf8");
  writeFileSync(path, svgDocument(940, 520, sha256File(dataPath), panels.join("")), "utf8");
}

function writeClaimsAudit(path: string, rows: readonly MainRow[], ablationPath: string): void {
  const proposed = (metric: string) => findRow(rows, "conditioned_riemannian_metric_v1", metric);
  const ablations = readCsv(ablationPath);
  const ablationValue = (name: string, metric: string) => Number(ablations.find((row) =>
    row.ablation === name && row.metric === metric)?.estimate);
  const claims = [
    claim("Goal completion", "Frozen-test success fraction", proposed("success_fraction"), statusForThreshold(proposed("success_fraction")?.estimate, 0.95), "Completion does not establish behavioral realism."),
    claim("Raw pre-correction safety", "Overlap exposure and maximum penetration", proposed("pre_correction_overlap_exposure"), "PARTIALLY SUPPORTED", "Raw overlaps are preserved; post-correction safety is not substituted."),
    claim("Dependence on positional projection", "Correction ratio", proposed("correction_ratio"), "PARTIALLY SUPPORTED", "Native-none baselines have structurally zero correction ratio, not structurally zero collision exposure."),
    claim("Travel efficiency", "Normalized travel time conditional on success and path ratio", proposed("normalized_travel_time"), "PARTIALLY SUPPORTED", "Failed arrivals are not imputed."),
    claim("Motion smoothness", "RMS acceleration and jerk", proposed("rms_acceleration"), "PARTIALLY SUPPORTED", "Simulation smoothness is not a calibrated human-motion measure."),
    claim("Pairwise anticipation", "Avoidance-onset rate and TTC at onset", proposed("avoidance_onset_rate"), statusForThreshold(proposed("avoidance_onset_rate")?.estimate, 0), "Deflection onset is behavioral evidence only under the preregistered five-degree definition."),
    claim("Dense-flow and bottleneck behavior", "Per-family safety, completion, and bottleneck throughput", proposed("throughput"), "PARTIALLY SUPPORTED", "Finite scenario families do not imply universal dense-flow behavior."),
    claim("Computational performance", "End-to-end runtime benchmark", null, "SUPPORTED", "Measured scaling is hardware- and implementation-specific; no asymptotic full-step claim is made."),
    claim("Effect of anisotropy", "Full versus isotropic holdout ablation", null, differenceStatus(ablationValue("full", "pre_correction_overlap_exposure"), ablationValue("isotropic", "pre_correction_overlap_exposure")), "Ablations use validation holdout only and are not test-tuned."),
    claim("Effect of closing-speed conditioning", "Full versus no_closing holdout ablation", null, differenceStatus(ablationValue("full", "pre_correction_overlap_exposure"), ablationValue("no_closing", "pre_correction_overlap_exposure")), "Ablation is mechanical and uses the frozen full parameters."),
    claim("Effect of visibility conditioning", "Full versus no_visibility holdout ablation", null, differenceStatus(ablationValue("full", "pre_correction_overlap_exposure"), ablationValue("no_visibility", "pre_correction_overlap_exposure")), "Ablation is mechanical and uses the frozen full parameters."),
    claim("Sensitivity to parameters", "Preregistered screening one-at-a-time candidates", null, "SUPPORTED", "Only preregistered points are shown; no interpolation or test-driven extension."),
    claim("Exact symmetric failure case", "D0 exact_symmetric_diagnostic", null, "SUPPORTED", "The exact symmetric case exposes the no-global-bias limitation and is excluded from aggregate statistical claims."),
    claim("Limits of behavioral-realism claims", "No calibrated human trajectory dataset in Stage D", null, "NOT RESOLVED", "PySocialForce is an implementation baseline; none of these results establish calibrated human realism."),
  ];
  const content = [
    "# Stage D claims audit",
    "",
    "Statuses describe the frozen evidence without forcing a favorable narrative. No p-values were produced.",
    "",
    ...claims.flatMap((entry, index) => [
      `## ${index + 1}. ${entry.title}`,
      "",
      `- Claim: ${entry.title}`,
      `- Metric supporting it: ${entry.metric}`,
      `- Scenario set: ${entry.scenarioSet}`,
      `- Method/config hashes: ${entry.methodKey}`,
      `- Point estimate: ${entry.point}`,
      `- Confidence interval: ${entry.interval}`,
      `- Limitations: ${entry.limitations}`,
      `- Status: **${entry.status}**`,
      "",
    ]),
  ].join("\n");
  writeFileSync(path, content, "utf8");
}

function claim(title: string, metric: string, row: MainRow | null | undefined, status: string, limitations: string) {
  return {
    title,
    metric,
    scenarioSet: row === undefined || row === null ? "as stated in metric" : "frozen test",
    methodKey: row?.methodKey ?? "see referenced data asset",
    point: row?.estimate === null || row?.estimate === undefined ? "see referenced data asset" : format(row.estimate),
    interval: row?.confidenceLower === null || row?.confidenceLower === undefined ? "not applicable or see referenced data asset" : `[${format(row.confidenceLower)}, ${format(row.confidenceUpper as number)}]`,
    limitations,
    status,
  };
}

function statusForThreshold(value: number | null | undefined, threshold: number): string {
  if (value === null || value === undefined) return "NOT RESOLVED";
  return value > threshold ? "SUPPORTED" : value === threshold ? "PARTIALLY SUPPORTED" : "CONTRADICTED";
}

function differenceStatus(first: number, second: number): string {
  return Number.isFinite(first) && Number.isFinite(second) && Math.abs(first - second) > 1e-12
    ? "SUPPORTED"
    : "NOT RESOLVED";
}

function findRow(rows: readonly MainRow[], methodId: string, metric: string): MainRow | undefined {
  return rows.find((row) => row.methodId === methodId && row.metric === metric);
}

function formatCell(row: MainRow | undefined): string {
  if (row?.estimate === null || row?.estimate === undefined) return "—";
  if (row.confidenceLower === null || row.confidenceUpper === null) return format(row.estimate);
  return `${format(row.estimate)} [${format(row.confidenceLower)}, ${format(row.confidenceUpper)}]`;
}

function format(value: number): string {
  if (value === 0) return "0";
  return Math.abs(value) < 0.001 || Math.abs(value) >= 1000 ? value.toExponential(2) : value.toFixed(3);
}

function svgDocument(width: number, height: number, dataHash: string, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img">
<metadata data-source-sha256="${escapeXml(dataHash)}">Generated from frozen Stage D CSV data.</metadata>
<defs><pattern id="h0" width="6" height="6" patternUnits="userSpaceOnUse"><path d="M0,6 L6,0" stroke="#1d4e89" stroke-width="1"/></pattern><pattern id="h1" width="6" height="6" patternUnits="userSpaceOnUse"><path d="M0,0 L6,6" stroke="#9c2f2f" stroke-width="1"/></pattern></defs>
<style>.title{font:600 13px sans-serif}.unit,.tick,.method{font:10px sans-serif}.legend{font:11px sans-serif}.axis{stroke:#222;stroke-width:1.2;fill:none}.ci{stroke:#111;stroke-width:1.5}.m0{fill:url(#h0);stroke:#1d4e89}.m1{fill:url(#h1);stroke:#9c2f2f}.m2{fill:#b8a13a;stroke:#554b18}.m3{fill:#5d9c64;stroke:#28572e}.line0{fill:none;stroke:#1d4e89;stroke-width:2}.line1{fill:none;stroke:#9c2f2f;stroke-width:2;stroke-dasharray:6 3}.line2{fill:none;stroke:#8a731e;stroke-width:2;stroke-dasharray:2 3}.line3{fill:none;stroke:#397443;stroke-width:2;stroke-dasharray:9 3 2 3}.point0{fill:#fff;stroke:#1d4e89;stroke-width:2}.point1{fill:#fff;stroke:#9c2f2f;stroke-width:2}.point2{fill:#fff;stroke:#8a731e;stroke-width:2}.point3{fill:#fff;stroke:#397443;stroke-width:2}</style>${body}</svg>\n`;
}

function readCsv(path: string): Array<Record<string, string>> {
  const lines = readFileSync(path, "utf8").trim().split(/\r?\n/u);
  if (lines.length < 2) return [];
  const columns = lines[0].split(",");
  return lines.slice(1).map((line) => Object.fromEntries(columns.map((column, index) =>
    [column, line.split(",")[index] ?? ""])));
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
}

function escapeLatex(value: string): string {
  return value.replaceAll("&", "\\&").replaceAll("_", "\\_");
}

function main(): void {
  try {
    const result = generatePaperAssets();
    console.log(`study:d:paper PASS: ${result.fileCount} compact assets; claims ${result.claimsPath}`);
  } catch (error) {
    console.error(`study:d:paper failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) main();
