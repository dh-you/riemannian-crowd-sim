import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SimulatorCore, type SimulatorCoreOptions } from "../../src/core/SimulatorCore";
import { CONTROLLER_ID } from "../../src/core/types";

describe("determinism and headless isolation", () => {
  it("produces numerically identical repeated runs", () => {
    const first = runFixture();
    const second = runFixture();
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("keeps every scientific core source free of Three.js, DOM, and rendering imports", () => {
    const files = walk(join(process.cwd(), "src", "core")).filter((path) => path.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const path of files) {
      const source = readFileSync(path, "utf8");
      expect(source, path).not.toMatch(/from\s+["']three["']|import\s+\*\s+as\s+THREE/u);
      expect(source, path).not.toMatch(/\b(?:document|window|requestAnimationFrame)\b/u);
      expect(source, path).not.toMatch(/\.\.\/utils\/(?:Agent|Environment|Wall)/u);
    }
  });
});

function runFixture(): unknown[] {
  const simulator = new SimulatorCore(options());
  const result: unknown[] = [];
  for (let index = 0; index < 25; index += 1) {
    result.push({ diagnostic: simulator.step(), state: simulator.getAgents() });
  }
  return result;
}

function options(): SimulatorCoreOptions {
  return {
    agents: [
      { id: 0, position: [-2, -0.1], velocity: [1, 0], goal: [2, -0.1], radius: 0.3, preferredSpeed: 1, arrived: false },
      { id: 1, position: [2, 0.1], velocity: [-1, 0], goal: [-2, 0.1], radius: 0.3, preferredSpeed: 1, arrived: false },
    ],
    walls: [],
    simulation: {
      dt: 0.02,
      goalTolerance: 0.01,
      velocityTimeConstant: 0.04,
      correction: { enabled: true, iterations: 2, padding: 0.001 },
    },
    controller: { id: CONTROLLER_ID, alpha: 10, sigma: 2.4, lambdaR: 10, lambdaT: 1 },
  };
}

function walk(directory: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walk(path));
    else result.push(path);
  }
  return result;
}
