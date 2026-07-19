import { execFileSync } from "node:child_process";
import { cpus, platform, release, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runExperiment } from "../../../cli/runExperiment";
import { generateCircleAntipodalScenario } from "../../../generation/circleAntipodal";
import { sha256Bytes, sha256File } from "../../../protocol/hash";
import { serializeExperimentScenario } from "../../../protocol/schema";
import { readBuildManifest } from "../../../baselines/common/thirdParty";
import { FREEZE_MANIFEST_PATH } from "./freezeConfigurations";
import { assertFrozenExecutionState } from "./runFrozenTest";
import { RESULTS_ROOT, currentGitHead, phaseManifestPath, writeJson } from "../studyPaths";

interface RuntimeMeasurement {
  methodId: string;
  methodKey: string;
  population: number;
  repetition: number;
  wallClockSeconds: number;
  agentSteps: number;
  agentStepsPerSecond: number;
  scenarioSha256: string;
}

interface RuntimeSummary {
  methodId: string;
  methodKey: string;
  population: number;
  medianWallClockSeconds: number;
  firstQuartileWallClockSeconds: number;
  thirdQuartileWallClockSeconds: number;
  interquartileRangeSeconds: number;
  medianAgentStepsPerSecond: number;
}

export function runRuntimeStudy(): { measurements: RuntimeMeasurement[]; summaries: RuntimeSummary[] } {
  const freeze = assertFrozenExecutionState();
  const mergedPath = resolve(RESULTS_ROOT, "test/merged-test-manifest.json");
  const merged = JSON.parse(readFileSync(mergedPath, "utf8")) as { status?: string };
  if (merged.status !== "PASS") throw new Error("Frozen test merge must pass before runtime study");
  const measurements: RuntimeMeasurement[] = [];
  for (const population of freeze.runtimePolicy.populationSizes) {
    const generated = generateCircleAntipodalScenario("runtime", 20260718 + population, population);
    const scenario = {
      ...generated,
      name: `runtime-circle-n${population}`,
      simulation: { ...generated.simulation, horizonSeconds: freeze.runtimePolicy.horizonSeconds },
    };
    const source = serializeExperimentScenario(scenario);
    const scenarioPath = resolve(RESULTS_ROOT, "runtime/scenarios", `n-${population}.json`);
    mkdirSync(dirname(scenarioPath), { recursive: true });
    writeFileSync(scenarioPath, source, "utf8");
    const scenarioSha256 = sha256Bytes(source);
    for (const method of freeze.frozenMethods) {
      for (let repetition = -freeze.runtimePolicy.warmups;
        repetition < freeze.runtimePolicy.repetitions;
        repetition += 1) {
        const label = repetition < 0 ? `warmup-${-repetition}` : `repetition-${repetition}`;
        const output = resolve(RESULTS_ROOT, "runtime/raw", `n-${population}`, method.methodKey, label);
        if (existsSync(resolve(output, "manifest.json"))) {
          throw new Error(`Runtime output already exists; refusing a selective rerun: ${output}`);
        }
        const before = performance.now();
        const result = runExperiment({
          scenarioPath,
          methodPath: method.path,
          outputDirectory: output,
          recordingInterval: 1_000_000_000,
          commandArguments: ["study:d:runtime", String(population), method.methodId, label],
        });
        const elapsed = (performance.now() - before) / 1000;
        if (result.manifest.scenarioSha256 !== scenarioSha256
          || result.manifest.methodKey !== method.methodKey
          || result.summary.nonFiniteValueOccurred) {
          throw new Error(`Runtime provenance mismatch for ${method.methodId} N=${population}`);
        }
        if (repetition >= 0) {
          const agentSteps = result.summary.totalSteps * population;
          measurements.push({
            methodId: method.methodId,
            methodKey: method.methodKey,
            population,
            repetition,
            wallClockSeconds: elapsed,
            agentSteps,
            agentStepsPerSecond: agentSteps / elapsed,
            scenarioSha256,
          });
        }
      }
    }
  }
  const summaries: RuntimeSummary[] = [];
  for (const method of freeze.frozenMethods) {
    for (const population of freeze.runtimePolicy.populationSizes) {
      const group = measurements.filter((measurement) =>
        measurement.methodId === method.methodId && measurement.population === population);
      if (group.length !== freeze.runtimePolicy.repetitions) {
        throw new Error(`Runtime repetition count mismatch for ${method.methodId} N=${population}`);
      }
      const times = group.map(({ wallClockSeconds }) => wallClockSeconds);
      const rates = group.map(({ agentStepsPerSecond }) => agentStepsPerSecond);
      const firstQuartile = percentile(times, 0.25);
      const thirdQuartile = percentile(times, 0.75);
      summaries.push({
        methodId: method.methodId,
        methodKey: method.methodKey,
        population,
        medianWallClockSeconds: percentile(times, 0.5),
        firstQuartileWallClockSeconds: firstQuartile,
        thirdQuartileWallClockSeconds: thirdQuartile,
        interquartileRangeSeconds: thirdQuartile - firstQuartile,
        medianAgentStepsPerSecond: percentile(rates, 0.5),
      });
    }
  }
  const build = readBuildManifest();
  const manifest = {
    runtimeManifestVersion: 1,
    status: "PASS",
    repositoryCommit: currentGitHead(),
    freezeManifestSha256: sha256File(FREEZE_MANIFEST_PATH),
    protocol: freeze.runtimePolicy,
    hardware: {
      cpuModel: cpus()[0]?.model ?? "unavailable",
      logicalCoreCount: cpus().length,
      physicalCoreCount: physicalCoreCount(),
      memoryBytes: totalmem(),
      operatingSystem: `${platform()} ${release()}`,
      nodeVersion: process.version,
      pythonVersion: commandVersion(process.platform === "win32" ? "python" : "python3", ["--version"]),
      compiler: build.compiler,
      baselineBuildManifestSha256: sha256File(resolve("experiments/third_party/build/build-manifest.json")),
      powerMode: powerMode(),
    },
    instrumentation: {
      endToEnd: "measured",
      controllerOnly: "unavailable without modifying frozen implementation",
      contactDiagnostics: "unavailable without modifying frozen implementation",
      positionalCorrection: "unavailable without modifying frozen implementation"
    },
    measurements,
    summaries,
  };
  writeJson(phaseManifestPath("runtime"), manifest);
  const compactPath = resolve(RESULTS_ROOT, "compact/runtime-results.csv");
  mkdirSync(dirname(compactPath), { recursive: true });
  writeFileSync(compactPath, [
    "method_id,method_key,population,median_wall_clock_seconds,first_quartile_seconds,third_quartile_seconds,interquartile_range_seconds,median_agent_steps_per_second",
    ...summaries.map((row) => [
      row.methodId,
      row.methodKey,
      row.population,
      row.medianWallClockSeconds,
      row.firstQuartileWallClockSeconds,
      row.thirdQuartileWallClockSeconds,
      row.interquartileRangeSeconds,
      row.medianAgentStepsPerSecond,
    ].join(",")),
  ].join("\n") + "\n", "utf8");
  return { measurements, summaries };
}

function percentile(values: readonly number[], probability: number): number {
  const ordered = [...values].sort((first, second) => first - second);
  if (ordered.length === 0) throw new Error("Cannot compute an empty runtime percentile");
  const position = (ordered.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const fraction = position - lower;
  return ordered[lower] * (1 - fraction) + ordered[upper] * fraction;
}

function commandVersion(executable: string, arguments_: readonly string[]): string {
  try {
    return execFileSync(executable, arguments_, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unavailable";
  }
}

function physicalCoreCount(): number | null {
  if (process.platform !== "win32") return null;
  const output = commandVersion("powershell.exe", [
    "-NoProfile",
    "-Command",
    "(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum",
  ]);
  const value = Number(output);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function powerMode(): string | null {
  if (process.platform !== "win32") return null;
  const output = commandVersion("powercfg.exe", ["/getactivescheme"]);
  return output === "unavailable" ? null : output;
}

function main(): void {
  try {
    const result = runRuntimeStudy();
    console.log(`study:d:runtime PASS: ${result.measurements.length} measured runs`);
  } catch (error) {
    console.error(`study:d:runtime failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) main();
