import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { baselineRuntimePaths } from "../../experiments/engines/baselineProvenance";
import { runExperiment, type RunExperimentResult } from "../../experiments/cli/runExperiment";
import { runAuditedEngine } from "../../experiments/lean/audit/auditRun";
import { packageViewerTrajectories } from "../../experiments/lean/worker";
import { buildAssignments, loadStudy } from "../../experiments/lean/run";
import { generateExperimentScenario } from "../../experiments/generation/generateScenario";
import { sha256File } from "../../experiments/protocol/hash";
import { parseExperimentScenario, serializeExperimentScenario, type ExperimentScenario } from "../../experiments/protocol/schema";

const temporaryDirectories: string[] = [];

afterEach(() => {
  temporaryDirectories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

describe("radius-aware PySocialForce adaptation", () => {
  it("passes force-level radius convention checks", () => {
    const runtime = baselineRuntimePaths();
    const result = spawnSync(runtime.python, [
      resolve("tests/baselines/radius_aware_force.py"),
      "--source-directory",
      runtime.socialSource,
    ], { encoding: "utf8" });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toMatch(/Ran 7 tests/u);
  });

  it("leaves the legacy runner, output identity, and correction semantics unchanged", () => {
    expect(sha256File(resolve("experiments/baselines/social_force/runner.py")))
      .toBe("c07aac123abaea1cb171fda2f041c276f72c3eef52b98e86c73bcce918aa8f6c");
    const scenario = shortened(loadFixture("pairwise-offset-head-on"), 4);
    const result = runFixture(scenario, "social-force-default.json");
    expect(result.manifest.controllerId).toBe("social_force_pysocialforce_v1");
    expect(result.manifest.engineId).toBe("pysocialforce_engine_v1");
    expect(result.manifest.engineAdapterVersion).toBe("3");
    expect(result.manifest.correctionMode).toBe("native_none");
    expect(result.manifest.commandVelocityMeaning)
      .toBe("native pre-position-update velocity after PySocialForce force integration");
    expect(result.manifest.radiusAware).toBeUndefined();
    expect(JSON.parse(readFileSync(result.manifestPath, "utf8"))).not.toHaveProperty("radiusAware");
    expect(result.manifest.runnerSha256)
      .toBe("c07aac123abaea1cb171fda2f041c276f72c3eef52b98e86c73bcce918aa8f6c");
  });

  it("records distinct radius-aware provenance and accepts unequal pedestrian radii", () => {
    const scenario = shortened(loadFixture("pairwise-offset-head-on"), 4);
    scenario.agents[0].radius = 0.2;
    scenario.agents[1].radius = 0.4;
    const result = runFixture(scenario, "social-force-radius-v2.json");
    expect(result.manifest.controllerId).toBe("social_force_pysocialforce_radius_v2");
    expect(result.manifest.engineId).toBe("pysocialforce_radius_engine_v2");
    expect(result.manifest.engineAdapterVersion).toBe("1");
    expect(result.manifest.correctionMode).toBe("native_none");
    expect(result.manifest.radiusAware).toBe(true);
    expect(result.manifest.distanceConvention)
      .toBe("surface_clearance = center_distance - radius_i - radius_j");
    expect(result.manifest.upstreamProject).toBe("PySocialForce");
    expect(result.manifest.upstreamVersion).toBe("1.1.2");
    expect(result.manifest.upstreamCommit).toBe("8c81cd1ed5db8d0e933417cec77954aa967d4459");
    expect(result.manifest.frozenParameters).toEqual(result.manifest.methodParameters);
    expect(result.manifest.adaptationSourceSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.manifest.implementationCommit).toMatch(/^[a-f0-9]{40}$/u);
    expect(result.metrics.identity.radiusAware).toBe(true);
  });

  it("is byte-deterministic and passes independent metrics verification", () => {
    const scenario = shortened(loadFixture("pairwise-offset-head-on"), 12);
    const root = directory();
    const scenarioPath = resolve(root, "scenario.json");
    const methodPath = resolve("experiments/methods/social-force-radius-v2.json");
    writeFileSync(scenarioPath, serializeExperimentScenario(scenario), "utf8");
    const firstDirectory = resolve(root, "first", "audit", "visuals", "runs", scenario.name, "radius");
    const secondDirectory = resolve(root, "second", "audit", "visuals", "runs", scenario.name, "radius");
    runAuditedEngine(scenarioPath, methodPath, firstDirectory);
    runAuditedEngine(scenarioPath, methodPath, secondDirectory);
    expect(readFileSync(resolve(firstDirectory, "engine-steps.jsonl"), "utf8"))
      .toBe(readFileSync(resolve(secondDirectory, "engine-steps.jsonl"), "utf8"));
    packageViewerTrajectories(resolve(root, "first", "audit"));
    const checked = spawnSync(
      process.platform === "win32" ? "python" : "python3",
      [resolve("experiments/lean/analyze.py"), "--verify-run", firstDirectory],
      { encoding: "utf8" },
    );
    expect(checked.status, `${checked.stdout}\n${checked.stderr}`).toBe(0);

    const corridor = shortened(generateExperimentScenario({
      family: "bidirectional",
      variant: "corridor",
      split: "lean",
      seed: 0,
      agentCount: 120,
    }), 2);
    const corridorScenarioPath = resolve(root, "corridor-scenario.json");
    const corridorDirectory = resolve(
      root, "corridor", "audit", "visuals", "runs", corridor.name, "radius",
    );
    writeFileSync(corridorScenarioPath, serializeExperimentScenario(corridor), "utf8");
    runAuditedEngine(corridorScenarioPath, methodPath, corridorDirectory);
    packageViewerTrajectories(resolve(root, "corridor", "audit"));
    const corridorChecked = spawnSync(
      process.platform === "win32" ? "python" : "python3",
      [resolve("experiments/lean/analyze.py"), "--verify-run", corridorDirectory],
      { encoding: "utf8" },
    );
    expect(corridorChecked.status, `${corridorChecked.stdout}\n${corridorChecked.stderr}`).toBe(0);
  });

  it("builds a 70-run repair headline containing only the requested method", () => {
    const study = loadStudy(resolve("experiments/lean/study-sfm-radius.json"));
    expect(Object.keys(study.methods)).toEqual(["social-force-radius"]);
    const audit = buildAssignments(study, "audit");
    const headline = buildAssignments(study, "test");
    const runtime = buildAssignments(study, "runtime");
    expect(audit).toHaveLength(5);
    expect(headline).toHaveLength(70);
    expect(runtime).toHaveLength(12);
    expect([...audit, ...headline, ...runtime].every((assignment) =>
      assignment.method === "social-force-radius"
      && (assignment.methodConfig as { id: string }).id === "social_force_pysocialforce_radius_v2"
    )).toBe(true);
  });
});

function directory(): string {
  const path = mkdtempSync(resolve(tmpdir(), "radius-sfm-test-"));
  temporaryDirectories.push(path);
  return path;
}

function runFixture(scenario: ExperimentScenario, methodName: string): RunExperimentResult {
  const root = directory();
  const scenarioPath = resolve(root, "scenario.json");
  writeFileSync(scenarioPath, serializeExperimentScenario(scenario), "utf8");
  return runExperiment({
    scenarioPath,
    methodPath: resolve("experiments", "methods", methodName),
    outputDirectory: resolve(root, "run"),
  });
}

function loadFixture(name: string): ExperimentScenario {
  const source = readFileSync(resolve("experiments", "baselines", "fixtures", `${name}.json`), "utf8");
  return parseExperimentScenario(JSON.parse(source) as unknown);
}

function shortened(scenario: ExperimentScenario, steps: number): ExperimentScenario {
  return {
    ...scenario,
    simulation: { ...scenario.simulation, horizonSeconds: scenario.simulation.dt * steps },
    agents: scenario.agents.map((agent) => ({
      ...agent,
      position: [...agent.position],
      velocity: [...agent.velocity],
      goal: [...agent.goal],
    })),
    walls: scenario.walls.map((wall) => ({
      ...wall,
      start: [...wall.start],
      end: [...wall.end],
    })),
  };
}
