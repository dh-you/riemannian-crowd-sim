import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertNoInitialPhysicalOverlaps,
  DEFAULT_PREFERRED_SPEED,
} from "../../experiments/generation/common";
import { generateBottleneckScenario } from "../../experiments/generation/bottleneck";
import { generateExperimentScenario } from "../../experiments/generation/generateScenario";
import { DeterministicRandom } from "../../experiments/generation/random";
import {
  assertSafeOutputDirectory,
  expandSuiteDefinition,
  parseSuiteDefinition,
} from "../../experiments/generation/suite";
import { serializeExperimentScenario } from "../../experiments/protocol/schema";

const representativeRequests = [
  { family: "pairwise", variant: "head_on", split: "validation", seed: 0 },
  { family: "circle_antipodal", variant: "perturbed", split: "validation", seed: 0, agentCount: 50 },
  { family: "bidirectional", variant: "corridor", split: "validation", seed: 0, agentCount: 120 },
  { family: "bottleneck", variant: "central_opening", split: "validation", seed: 0, agentCount: 112 },
] as const;

describe("repository-owned deterministic PRNG", () => {
  it("matches the committed Mulberry32 golden sequence", () => {
    const random = new DeterministicRandom(123456789);
    expect(Array.from({ length: 6 }, () => random.nextUint32())).toEqual([
      1107202814, 4169434471, 3372958138, 885470128, 1301683845, 3208624240,
    ]);
  });

  it("repeats identical seeds and distinguishes different seeds", () => {
    const sequence = (seed: number): number[] => {
      const random = new DeterministicRandom(seed);
      return Array.from({ length: 10 }, () => random.nextFloat());
    };
    expect(sequence(42)).toEqual(sequence(42));
    expect(sequence(42)).not.toEqual(sequence(43));
  });

  it("samples deterministic bounded floats, integers, and shuffles", () => {
    const first = new DeterministicRandom(9);
    const second = new DeterministicRandom(9);
    const sample = (random: DeterministicRandom): unknown[] => [
      random.floatBetween(-2, 4),
      random.integerBetween(3, 8),
      random.shuffle([0, 1, 2, 3, 4]),
    ];
    const output = sample(first);
    expect(output).toEqual(sample(second));
    expect(output[0] as number).toBeGreaterThanOrEqual(-2);
    expect(output[0] as number).toBeLessThan(4);
    expect(output[1] as number).toBeGreaterThanOrEqual(3);
    expect(output[1] as number).toBeLessThan(8);
  });
});

describe("deterministic scenario families", () => {
  it("permits only strict descendants of repository-owned generator directories", () => {
    const repositoryRoot = resolve(".");
    expect(() =>
      assertSafeOutputDirectory(
        resolve("experiments/generated/protocol-safety-test"),
        repositoryRoot,
      ),
    ).not.toThrow();
    expect(() =>
      assertSafeOutputDirectory(resolve("experiments/tmp/protocol-safety-test"), repositoryRoot),
    ).not.toThrow();
    for (const unsafePath of [
      repositoryRoot,
      resolve("experiments/generated"),
      resolve("experiments/tmp"),
      resolve("results/mistyped-output"),
      resolve(tmpdir(), "mistyped-output"),
    ]) {
      expect(() => assertSafeOutputDirectory(unsafePath, repositoryRoot)).toThrow(
        /Refusing to clear generator output/u,
      );
    }
  });

  it.each(["experiments", "generated", "descendant"])(
    "rejects a symbolic-link or junction at the %s path level",
    (level) => {
      const root = mkdtempSync(resolve(tmpdir(), "generator-symlink-root-"));
      const outside = mkdtempSync(resolve(tmpdir(), "generator-symlink-outside-"));
      try {
        if (level === "experiments") {
          symlinkSync(outside, resolve(root, "experiments"), "junction");
        } else {
          mkdirSync(resolve(root, "experiments"), { recursive: true });
          if (level === "generated") {
            symlinkSync(outside, resolve(root, "experiments", "generated"), "junction");
          } else {
            mkdirSync(resolve(root, "experiments", "generated"), { recursive: true });
            symlinkSync(outside, resolve(root, "experiments", "generated", "linked"), "junction");
          }
        }
        const candidate =
          level === "descendant"
            ? resolve(root, "experiments", "generated", "linked", "suite")
            : resolve(root, "experiments", "generated", "suite");
        expect(() => assertSafeOutputDirectory(candidate, root)).toThrow(/symbolic|resolves/iu);
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it.each(representativeRequests)("generates $family byte-identically and physically valid", (request) => {
    const first = generateExperimentScenario(request);
    const second = generateExperimentScenario(request);
    expect(serializeExperimentScenario(first)).toBe(serializeExperimentScenario(second));
    expect(first.agents.map(({ id }) => id)).toEqual(
      Array.from({ length: first.agents.length }, (_, id) => id),
    );
    expect(new Set(first.agents.map(({ id }) => id)).size).toBe(first.agents.length);
    expect(JSON.stringify(first)).not.toMatch(/NaN|Infinity/u);
    expect(() => assertNoInitialPhysicalOverlaps(first)).not.toThrow();
    for (const wall of first.walls) {
      expect(Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1])).toBeGreaterThan(0);
    }
  });

  it("closes the bottleneck chamber around one exact central opening", () => {
    const openingWidth = 2.4;
    const first = generateBottleneckScenario("validation", 17, 112, { openingWidth });
    const second = generateBottleneckScenario("validation", 17, 112, { openingWidth });
    expect(serializeExperimentScenario(first)).toBe(serializeExperimentScenario(second));
    expect(first.walls).toEqual([
      { id: 0, start: [-14, -6], end: [12, -6], thickness: 0.1 },
      { id: 1, start: [-14, 6], end: [12, 6], thickness: 0.1 },
      { id: 2, start: [-14, -6], end: [-14, 6], thickness: 0.1 },
      { id: 3, start: [12, -6], end: [12, 6], thickness: 0.1 },
      { id: 4, start: [0, -6], end: [0, -openingWidth / 2], thickness: 0.1 },
      { id: 5, start: [0, openingWidth / 2], end: [0, 6], thickness: 0.1 },
    ]);
    expect(first.walls[5].start[1] - first.walls[4].end[1]).toBe(openingWidth);
    for (const agent of first.agents) {
      expect(agent.position[0]).toBeGreaterThan(-14);
      expect(agent.position[0]).toBeLessThan(12);
      expect(agent.position[1]).toBeGreaterThan(-6);
      expect(agent.position[1]).toBeLessThan(6);
      expect(agent.goal[0]).toBeGreaterThan(0);
      expect(agent.goal[0]).toBeLessThan(12);
      expect(agent.goal[1]).toBeGreaterThan(-6);
      expect(agent.goal[1]).toBeLessThan(6);
    }
    expect(() => assertNoInitialPhysicalOverlaps(first)).not.toThrow();
  });

  it("uses the exact required validation and test population sizes", () => {
    const counts = [
      ["circle_antipodal", "perturbed", 50, 100],
      ["bidirectional", "corridor", 120, 240],
      ["bottleneck", "central_opening", 112, 224],
    ] as const;
    for (const [family, variant, validationCount, testCount] of counts) {
      expect(
        generateExperimentScenario({ family, variant, split: "validation", seed: 0, agentCount: validationCount })
          .agents,
      ).toHaveLength(validationCount);
      expect(
        generateExperimentScenario({ family, variant, split: "test", seed: 1000, agentCount: testCount }).agents,
      ).toHaveLength(testCount);
    }
  });

  it("keeps exact symmetry diagnostic exact and statistical head-on asymmetric", () => {
    const exact = generateExperimentScenario({
      family: "pairwise",
      variant: "exact_symmetric_diagnostic",
      split: "diagnostic",
      seed: 0,
    });
    const [left, right] = exact.agents;
    expect(left.position[0]).toBe(-right.position[0]);
    expect(left.position[1]).toBeCloseTo(-right.position[1], 15);
    expect(left.goal).toEqual(right.position);
    expect(right.goal).toEqual(left.position);
    expect(left.preferredSpeed).toBe(DEFAULT_PREFERRED_SPEED);
    expect(right.preferredSpeed).toBe(DEFAULT_PREFERRED_SPEED);

    const statistical = generateExperimentScenario(representativeRequests[0]);
    expect(statistical.agents[0].position[1]).not.toBe(0);
    expect(statistical.agents[0].position[1]).toBe(-statistical.agents[1].position[1]);
  });

  it("places family goals on their intended opposite or exit side", () => {
    const circle = generateExperimentScenario(representativeRequests[1]);
    for (const agent of circle.agents) {
      expect(agent.goal[0]).toBeCloseTo(-agent.position[0], 14);
      expect(agent.goal[1]).toBeCloseTo(-agent.position[1], 14);
    }
    const flow = generateExperimentScenario(representativeRequests[2]);
    for (const agent of flow.agents) expect(Math.sign(agent.goal[0])).toBe(-Math.sign(agent.position[0]));
    const bottleneck = generateExperimentScenario(representativeRequests[3]);
    for (const agent of bottleneck.agents) {
      expect(agent.position[0]).toBeLessThan(0);
      expect(agent.goal[0]).toBeGreaterThan(0);
    }
  });

  it("defines disjoint validation/test seed splits and the expected 346 scenarios", () => {
    const suite = parseSuiteDefinition(
      JSON.parse(readFileSync(resolve("experiments/suites/protocol-v1.json"), "utf8")) as unknown,
    );
    const requests = expandSuiteDefinition(suite);
    expect(requests).toHaveLength(346);
    const validationSeeds = new Set(requests.filter(({ split }) => split === "validation").map(({ seed }) => seed));
    const testSeeds = new Set(requests.filter(({ split }) => split === "test").map(({ seed }) => seed));
    expect([...validationSeeds].every((seed) => !testSeeds.has(seed))).toBe(true);
    expect(Math.max(...validationSeeds)).toBe(9);
    expect(Math.min(...testSeeds)).toBe(1000);
  });

  it.each([
    [representativeRequests[0], "validation/pairwise/head_on/seed-0.json"],
    [representativeRequests[1], "validation/circle_antipodal/perturbed/seed-0.json"],
    [representativeRequests[2], "validation/bidirectional/corridor/seed-0.json"],
    [representativeRequests[3], "validation/bottleneck/central_opening/seed-0.json"],
  ] as const)("matches committed golden fixture %#", (request, fixturePath) => {
    const expected = readFileSync(resolve("experiments/fixtures/protocol-v1", fixturePath), "utf8");
    expect(serializeExperimentScenario(generateExperimentScenario(request))).toBe(expected);
  });

  it("matches the committed exact symmetric diagnostic fixture", () => {
    const request = {
      family: "pairwise",
      variant: "exact_symmetric_diagnostic",
      split: "diagnostic",
      seed: 0,
    } as const;
    const expected = readFileSync(
      resolve("experiments/fixtures/protocol-v1/diagnostic/pairwise/exact_symmetric_diagnostic/exact.json"),
      "utf8",
    );
    expect(serializeExperimentScenario(generateExperimentScenario(request))).toBe(expected);
  });
});
