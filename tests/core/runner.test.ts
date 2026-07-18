import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runScenario } from "../../experiments/cli/runScenario";

describe("streaming scenario runner", () => {
  it("streams selected records, includes the last step, and atomically finalizes", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "riemannian-core-runner-"));
    try {
      const outputDirectory = join(temporaryRoot, "output");
      const result = runScenario({
        scenarioPath: resolve("experiments/scenarios/free-space.json"),
        outputDirectory,
        recordingInterval: 7,
        commandArguments: ["runner-test"],
      });
      expect(existsSync(result.manifestPath)).toBe(true);
      expect(existsSync(result.trajectoryPath)).toBe(true);
      expect(existsSync(result.summaryPath)).toBe(true);
      expect(existsSync(join(outputDirectory, "trajectory.jsonl.tmp"))).toBe(false);

      const trajectoryText = readFileSync(result.trajectoryPath, "utf8");
      expect(trajectoryText.endsWith("\n")).toBe(true);
      const records = trajectoryText.trim().split(/\r?\n/u).map((line) => JSON.parse(line) as { stepIndex: number });
      expect(records).toHaveLength(3);
      expect(records.map((record) => record.stepIndex)).toEqual([6, 13, 19]);
      expect("records" in result).toBe(false);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("writes a valid empty trajectory for a zero-step scenario", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "riemannian-core-runner-zero-"));
    try {
      const scenario = JSON.parse(
        readFileSync(resolve("experiments/scenarios/free-space.json"), "utf8"),
      ) as { simulation: { horizonSeconds: number } };
      scenario.simulation.horizonSeconds = 0;
      const scenarioPath = join(temporaryRoot, "zero-step.json");
      writeFileSync(scenarioPath, JSON.stringify(scenario), "utf8");
      const outputDirectory = join(temporaryRoot, "output");
      const result = runScenario({ scenarioPath, outputDirectory });
      expect(readFileSync(result.trajectoryPath, "utf8")).toBe("");
      expect(result.summary.totalSteps).toBe(0);
      expect(existsSync(join(outputDirectory, "trajectory.jsonl.tmp"))).toBe(false);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("removes temporary and finalized trajectory files when a run fails", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "riemannian-core-runner-failure-"));
    try {
      const scenarioPath = join(temporaryRoot, "invalid.json");
      const outputDirectory = join(temporaryRoot, "output");
      mkdirSync(outputDirectory);
      writeFileSync(scenarioPath, "{", "utf8");
      writeFileSync(join(outputDirectory, "trajectory.jsonl"), "stale\n", "utf8");
      writeFileSync(join(outputDirectory, "trajectory.jsonl.tmp"), "partial\n", "utf8");
      expect(() => runScenario({ scenarioPath, outputDirectory })).toThrow(/Failed to read scenario/u);
      expect(existsSync(join(outputDirectory, "trajectory.jsonl"))).toBe(false);
      expect(existsSync(join(outputDirectory, "trajectory.jsonl.tmp"))).toBe(false);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
