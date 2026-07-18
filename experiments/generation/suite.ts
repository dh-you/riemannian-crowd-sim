import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sha256Bytes } from "../protocol/hash";
import { serializeExperimentScenario } from "../protocol/schema";
import {
  requireNonemptyIdentifier,
  requireSafeInteger,
  requireStrictObject,
} from "../protocol/validation";
import { GENERATOR_VERSION } from "./common";
import { generateExperimentScenario, type ScenarioGenerationRequest } from "./generateScenario";

export const SUITE_DEFINITION_VERSION = 1 as const;
export const SUITE_MANIFEST_VERSION = 1 as const;

export interface SuiteEntry {
  split: string;
  family: string;
  variants: string[];
  seedStart: number;
  seedEnd: number;
  agentCount?: number;
}

export interface SuiteDefinition {
  suiteVersion: typeof SUITE_DEFINITION_VERSION;
  suiteId: string;
  generatorVersion: typeof GENERATOR_VERSION;
  entries: SuiteEntry[];
}

export interface SuiteManifestScenario {
  path: string;
  seed: number;
  family: string;
  variant: string;
  split: string;
  agentCount: number;
  sha256: string;
}

export interface SuiteManifest {
  suiteManifestVersion: typeof SUITE_MANIFEST_VERSION;
  suiteVersion: number;
  suiteId: string;
  generatorVersion: string;
  suiteDefinitionSha256: string;
  gitCommitSha: string | null;
  scenarios: SuiteManifestScenario[];
}

export interface GenerateSuiteOptions {
  suitePath: string;
  outputDirectory: string;
}

export function parseSuiteDefinition(value: unknown): SuiteDefinition {
  const root = requireStrictObject(value, "suite", [
    "suiteVersion",
    "suiteId",
    "generatorVersion",
    "entries",
  ]);
  if (root.suiteVersion !== SUITE_DEFINITION_VERSION) {
    throw new Error(`Unsupported suiteVersion: ${String(root.suiteVersion)}`);
  }
  if (root.generatorVersion !== GENERATOR_VERSION) {
    throw new Error(`Unsupported generatorVersion: ${String(root.generatorVersion)}`);
  }
  if (!Array.isArray(root.entries) || root.entries.length === 0) {
    throw new Error("suite.entries must be a nonempty array");
  }
  const entries = root.entries.map((value_, index): SuiteEntry => {
    const path = `suite.entries[${index}]`;
    const entry = requireStrictObject(value_, path, [
      "split",
      "family",
      "variants",
      "seedStart",
      "seedEnd",
      "agentCount",
    ]);
    if (!Array.isArray(entry.variants) || entry.variants.length === 0) {
      throw new Error(`${path}.variants must be a nonempty array`);
    }
    const seedStart = requireSafeInteger(entry.seedStart, `${path}.seedStart`);
    const seedEnd = requireSafeInteger(entry.seedEnd, `${path}.seedEnd`);
    if (seedEnd < seedStart) throw new Error(`${path} seed range must be ordered`);
    const agentCount =
      entry.agentCount === undefined
        ? undefined
        : requireSafeInteger(entry.agentCount, `${path}.agentCount`);
    if (agentCount !== undefined && agentCount < 1) {
      throw new Error(`${path}.agentCount must be positive`);
    }
    return {
      split: requireNonemptyIdentifier(entry.split, `${path}.split`),
      family: requireNonemptyIdentifier(entry.family, `${path}.family`),
      variants: entry.variants.map((variant, variantIndex) =>
        requireNonemptyIdentifier(variant, `${path}.variants[${variantIndex}]`),
      ),
      seedStart,
      seedEnd,
      ...(agentCount === undefined ? {} : { agentCount }),
    };
  });
  return {
    suiteVersion: SUITE_DEFINITION_VERSION,
    suiteId: requireNonemptyIdentifier(root.suiteId, "suite.suiteId"),
    generatorVersion: GENERATOR_VERSION,
    entries,
  };
}

export function expandSuiteDefinition(definition: SuiteDefinition): ScenarioGenerationRequest[] {
  const requests: ScenarioGenerationRequest[] = [];
  for (const entry of definition.entries) {
    for (const variant of entry.variants) {
      for (let seed = entry.seedStart; seed <= entry.seedEnd; seed += 1) {
        requests.push({
          family: entry.family,
          variant,
          split: entry.split,
          seed,
          ...(entry.agentCount === undefined ? {} : { agentCount: entry.agentCount }),
        });
      }
    }
  }
  return requests.sort(compareRequests);
}

export function generateSuite(options: GenerateSuiteOptions): SuiteManifest {
  const suitePath = resolve(options.suitePath);
  const outputDirectory = resolve(options.outputDirectory);
  assertSafeOutputDirectory(outputDirectory);
  const suiteBytes = readFileSync(suitePath, "utf8");
  const definition = parseSuiteDefinition(JSON.parse(suiteBytes) as unknown);
  const requests = expandSuiteDefinition(definition);
  rmSync(outputDirectory, { recursive: true, force: true });
  mkdirSync(outputDirectory, { recursive: true });

  const scenarios: SuiteManifestScenario[] = [];
  for (const request of requests) {
    const scenario = generateExperimentScenario(request);
    const relativePath = scenarioRelativePath(request);
    const absolutePath = resolve(outputDirectory, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    const serialized = serializeExperimentScenario(scenario);
    writeFileSync(absolutePath, serialized, "utf8");
    scenarios.push({
      path: relativePath.replaceAll("\\", "/"),
      seed: scenario.seed,
      family: scenario.family,
      variant: scenario.variant,
      split: scenario.split,
      agentCount: scenario.agents.length,
      sha256: sha256Bytes(serialized),
    });
  }

  const manifest: SuiteManifest = {
    suiteManifestVersion: SUITE_MANIFEST_VERSION,
    suiteVersion: definition.suiteVersion,
    suiteId: definition.suiteId,
    generatorVersion: definition.generatorVersion,
    suiteDefinitionSha256: sha256Bytes(suiteBytes),
    gitCommitSha: readGitCommit(dirname(suitePath)),
    scenarios: scenarios.sort((a, b) => a.path.localeCompare(b.path)),
  };
  writeFileSync(
    resolve(outputDirectory, "suite-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
}

function compareRequests(first: ScenarioGenerationRequest, second: ScenarioGenerationRequest): number {
  return (
    first.split.localeCompare(second.split) ||
    first.family.localeCompare(second.family) ||
    first.variant.localeCompare(second.variant) ||
    first.seed - second.seed
  );
}

function scenarioRelativePath(request: ScenarioGenerationRequest): string {
  const filename =
    request.split === "diagnostic" && request.variant === "exact_symmetric_diagnostic"
      ? "exact.json"
      : `seed-${request.seed}.json`;
  return `${request.split}/${request.family}/${request.variant}/${filename}`;
}

function assertSafeOutputDirectory(outputDirectory: string): void {
  const workingDirectory = resolve(".");
  const relativePath = relative(workingDirectory, outputDirectory);
  if (outputDirectory === workingDirectory || relativePath === "" || !isAbsolute(outputDirectory)) {
    throw new Error("Refusing to generate a suite into the repository root");
  }
  if (outputDirectory === resolve(outputDirectory, "..")) {
    throw new Error("Refusing to generate a suite into a filesystem root");
  }
}

function readGitCommit(startDirectory: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: startDirectory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function parseArguments(arguments_: readonly string[]): GenerateSuiteOptions {
  let suitePath: string | undefined;
  let outputDirectory: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (argument === "--suite" && value !== undefined) {
      suitePath = value;
      index += 1;
    } else if (argument === "--out" && value !== undefined) {
      outputDirectory = value;
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${argument}`);
    }
  }
  if (suitePath === undefined) throw new Error("Missing required --suite path");
  if (outputDirectory === undefined) throw new Error("Missing required --out directory");
  return { suitePath, outputDirectory };
}

function main(): void {
  try {
    const options = parseArguments(process.argv.slice(2));
    const manifest = generateSuite(options);
    console.log(`exp:generate wrote ${manifest.scenarios.length} scenarios to ${resolve(options.outputDirectory)}`);
  } catch (error) {
    console.error(`exp:generate failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) main();
