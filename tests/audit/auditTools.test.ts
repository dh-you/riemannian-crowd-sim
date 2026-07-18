import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSnapshots } from "../../experiments/audit/cli/generateRiemannianSnapshots";
import { parseSnapshot } from "../../experiments/audit/cli/evaluateRiemannianSnapshots";

const python = process.platform === "win32" ? "python" : "python3";
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "d0-audit-test-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const path = temporaryDirectories.pop();
    if (path === undefined) continue;
    const realTemporary = realpathSync(tmpdir());
    const realTarget = realpathSync(path);
    const relation = relative(realTemporary, realTarget);
    if (relation === "" || relation === ".." || relation.startsWith(`..${sep}`)) {
      throw new Error(`Unsafe audit test cleanup target: ${realTarget}`);
    }
    rmSync(realTarget, { recursive: true, force: true });
  }
});

function evaluate(scenario: string, trajectory: string, output: string) {
  return spawnSync(python, [
    resolve("experiments/audit/python/evaluate_metrics.py"),
    "--scenario", resolve(scenario),
    "--trajectory", resolve(trajectory),
    "--out", output,
  ], { cwd: resolve("."), encoding: "utf8" });
}

describe("independent Stage D0 audit tooling", () => {
  it("keeps independent Python evaluators isolated from production implementations", () => {
    const metricSources = ["audit_common.py", "evaluate_metrics.py"].map((name) =>
      readFileSync(resolve("experiments", "audit", "python", name), "utf8"),
    ).join("\n");
    for (const forbidden of ["RunMetricsAccumulator", "engineStep.ts", "diagnostics.ts", "corrections.ts", "geometry.ts"]) {
      expect(metricSources).not.toContain(forbidden);
    }
    const controllerReference = readFileSync("experiments/audit/python/riemannian_reference.py", "utf8");
    expect(controllerReference).not.toMatch(/^\s*(?:from|import)\s+(?:numpy|scipy|torch|subprocess)\b/mu);
    expect(controllerReference).not.toContain("src/core");
  });

  it("passes analytical TTC, deflection, and finite-wall geometry cases", () => {
    const output = execFileSync(python, [resolve("experiments/audit/python/self_test.py")], { encoding: "utf8" });
    expect(output).toContain("passed");
  });

  it("reproduces the committed single-linear hand calculation", () => {
    const directory = temporaryDirectory();
    const outputPath = resolve(directory, "metrics.json");
    const result = evaluate(
      "experiments/audit/synthetic/single-linear-scenario.json",
      "experiments/audit/synthetic/single-linear-trajectory.jsonl",
      outputPath,
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toEqual(
      JSON.parse(readFileSync("experiments/audit/synthetic/single-linear-expected.json", "utf8")),
    );
  });

  it("accepts bounded JSONL-style CRLF input and blank lines", () => {
    const directory = temporaryDirectory();
    const source = readFileSync("experiments/audit/synthetic/single-linear-trajectory.jsonl", "utf8");
    const trajectory = resolve(directory, "trajectory.jsonl");
    writeFileSync(trajectory, `\r\n${source.replaceAll("\n", "\r\n\r\n")}`, "utf8");
    const result = evaluate("experiments/audit/synthetic/single-linear-scenario.json", trajectory, resolve(directory, "metrics.json"));
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it.each([
    ["malformed", "not json\n", "malformed JSON"],
    ["missing-agent", (record: Record<string, unknown>) => ({ ...record, agents: [] }), "agent IDs"],
    ["out-of-order", (record: Record<string, unknown>) => ({ ...record, agents: [...(record.agents as unknown[])].reverse() }), "agent IDs"],
    ["discontinuous", (record: Record<string, unknown>) => ({ ...record, agents: (record.agents as Record<string, unknown>[]).map((agent) => ({ ...agent, positionBefore: [99, 0] })) }), "discontinuous"],
  ])("rejects %s trajectory corruption", (_name, corruption, expectedMessage) => {
    const directory = temporaryDirectory();
    const original = readFileSync("experiments/audit/synthetic/pairwise-contact-trajectory.jsonl", "utf8").trim();
    const trajectory = resolve(directory, "bad.jsonl");
    const value = typeof corruption === "string" ? corruption : `${JSON.stringify(corruption(JSON.parse(original) as Record<string, unknown>))}\n`;
    writeFileSync(trajectory, value, "utf8");
    const result = evaluate("experiments/audit/synthetic/pairwise-contact-scenario.json", trajectory, resolve(directory, "metrics.json"));
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(expectedMessage);
  });

  it("renders a dependency-free SVG audit sheet", () => {
    const directory = temporaryDirectory();
    const outputPath = resolve(directory, "plot.svg");
    const result = spawnSync(python, [
      resolve("experiments/audit/python/render_trajectory_svg.py"),
      "--scenario", resolve("experiments/audit/synthetic/pairwise-contact-scenario.json"),
      "--trajectory", resolve("experiments/audit/synthetic/pairwise-contact-trajectory.jsonl"),
      "--out", outputPath,
      "--method", "synthetic",
    ], { encoding: "utf8" });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const svg = readFileSync(outputPath, "utf8");
    expect(svg).toContain("<svg");
    expect(svg).toContain("Minimum pre-correction agent clearance");
    expect(svg).toContain("stroke-dasharray");
  });

  it("materializes 107 deterministic snapshots and rejects extra schema fields", () => {
    const snapshots = buildSnapshots();
    expect(snapshots).toHaveLength(107);
    expect(() => parseSnapshot({ ...snapshots[0], unexpected: true }, 1)).toThrow(/not allowed/u);
  });

  it("comparison reports the first mismatch rather than changing tolerance", () => {
    const directory = temporaryDirectory();
    const independent = JSON.parse(readFileSync("experiments/audit/synthetic/single-linear-expected.json", "utf8")) as Record<string, unknown>;
    const pipeline = structuredClone(independent) as { throughput: number };
    pipeline.throughput = 0.6;
    const independentPath = resolve(directory, "independent.json");
    const pipelinePath = resolve(directory, "pipeline.json");
    const reportPath = resolve(directory, "report.json");
    writeFileSync(independentPath, JSON.stringify(independent), "utf8");
    writeFileSync(pipelinePath, JSON.stringify(pipeline), "utf8");
    const result = spawnSync(python, [resolve("experiments/audit/python/compare_metrics.py"), "--pipeline", pipelinePath, "--independent", independentPath, "--report", reportPath], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as { firstFailure: { metric: string }; status: string };
    expect(report.status).toBe("FAIL");
    expect(report.firstFailure.metric).toBe("throughput");
  });
});
