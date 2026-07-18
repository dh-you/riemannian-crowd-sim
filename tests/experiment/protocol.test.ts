import { describe, expect, it } from "vitest";
import { generateFreeSpaceScenario } from "../../experiments/generation/freeSpace";
import {
  controllerParametersFromMethod,
  ORCA_ENGINE_ID,
  ORCA_METHOD_ID,
  parseMethodConfig,
  SOCIAL_FORCE_ENGINE_ID,
  SOCIAL_FORCE_METHOD_ID,
} from "../../experiments/protocol/methodConfig";
import { sha256Bytes } from "../../experiments/protocol/hash";
import { createMethodKey, identifyMethod, serializeCanonicalMethodConfig } from "../../experiments/protocol/methodIdentity";
import {
  parseExperimentScenario,
  serializeExperimentScenario,
} from "../../experiments/protocol/schema";
import { CONTROLLER_ID, EUCLIDEAN_GOAL_CONTROLLER_ID } from "../../src/core/types";

const riemannianConfig = {
  methodConfigVersion: 1,
  id: CONTROLLER_ID,
  velocityTimeConstant: 0.04,
  parameters: { alpha: 10, sigma: 2.4, lambdaR: 10, lambdaT: 1 },
};
const goalConfig = {
  methodConfigVersion: 1,
  id: EUCLIDEAN_GOAL_CONTROLLER_ID,
  velocityTimeConstant: 0.04,
  parameters: {},
};
const orcaConfig = {
  methodConfigVersion: 2,
  id: ORCA_METHOD_ID,
  engine: ORCA_ENGINE_ID,
  parameters: { neighborDist: 5, maxNeighbors: 16, timeHorizon: 5, timeHorizonObst: 5 },
};
const socialForceConfig = {
  methodConfigVersion: 2,
  id: SOCIAL_FORCE_METHOD_ID,
  engine: SOCIAL_FORCE_ENGINE_ID,
  parameters: {
    desiredFactor: 1,
    relaxationTime: 0.5,
    socialFactor: 5.1,
    lambdaImportance: 2,
    gamma: 0.35,
    n: 2,
    nPrime: 3,
    obstacleFactor: 10,
    obstacleSigma: 0.2,
    obstacleThreshold: 3,
    maxSpeedMultiplier: 1.3,
    obstacleResolution: 10,
  },
};

describe("controller-independent experiment scenario schema", () => {
  it("round-trips valid physical scenarios without controller fields", () => {
    const scenario = generateFreeSpaceScenario("validation", 7);
    const serialized = serializeExperimentScenario(scenario);
    const parsed = parseExperimentScenario(JSON.parse(serialized) as unknown);
    expect(parsed).toEqual(scenario);
    expect(serialized).not.toMatch(/controller|alpha|lambdaR|velocityTimeConstant/u);
    expect(parsed.metadata.units).toEqual({ distance: "m", time: "s" });
  });

  it.each([
    ["unsupported version", (value: JsonObject) => (value.experimentScenarioVersion = 2)],
    ["malformed vector", (value: JsonObject) => (agents(value)[0].position = [0])],
    ["unsafe ID", (value: JsonObject) => (agents(value)[0].id = Number.MAX_SAFE_INTEGER + 1)],
    ["duplicate agent ID", (value: JsonObject) => agents(value).push({ ...agents(value)[0] })],
    ["nonpositive radius", (value: JsonObject) => (agents(value)[0].radius = 0)],
    ["nonpositive speed", (value: JsonObject) => (agents(value)[0].preferredSpeed = -1)],
    ["nonpositive timestep", (value: JsonObject) => (simulation(value).dt = 0)],
    ["negative horizon", (value: JsonObject) => (simulation(value).horizonSeconds = -1)],
    ["invalid correction", (value: JsonObject) => (correction(value).iterations = -1)],
    ["unknown physical field", (value: JsonObject) => (value.controller = {})],
    ["wrong units", (value: JsonObject) => ((value.metadata as JsonObject).units = { distance: "ft", time: "s" })],
  ])("rejects %s", (_label, mutate) => {
    const value = JSON.parse(serializeExperimentScenario(generateFreeSpaceScenario("validation", 0))) as JsonObject;
    mutate(value);
    expect(() => parseExperimentScenario(value)).toThrow();
  });

  it("rejects duplicate, degenerate, and malformed walls", () => {
    const base = JSON.parse(serializeExperimentScenario(generateFreeSpaceScenario("validation", 0))) as JsonObject;
    base.walls = [
      { id: 1, start: [0, 0], end: [1, 0], thickness: 0.1 },
      { id: 1, start: [0, 1], end: [1, 1], thickness: 0.1 },
    ];
    expect(() => parseExperimentScenario(base)).toThrow(/Duplicate wall id/u);
    (base.walls as JsonObject[]).splice(1);
    (base.walls as JsonObject[])[0].end = [0, 0];
    expect(() => parseExperimentScenario(base)).toThrow(/distinct finite endpoints/u);
  });
});

describe("method configuration schema", () => {
  it("parses both versioned methods and maps them to controller parameters", () => {
    expect(controllerParametersFromMethod(parseMethodConfig(riemannianConfig))).toEqual({
      id: CONTROLLER_ID,
      ...riemannianConfig.parameters,
    });
    expect(controllerParametersFromMethod(parseMethodConfig(goalConfig))).toEqual({
      id: EUCLIDEAN_GOAL_CONTROLLER_ID,
    });
  });

  it("strictly parses the ORCA and PySocialForce engine configurations", () => {
    expect(parseMethodConfig(orcaConfig)).toEqual(orcaConfig);
    expect(parseMethodConfig(socialForceConfig)).toEqual(socialForceConfig);
  });

  it.each([
    [{ ...orcaConfig, engine: SOCIAL_FORCE_ENGINE_ID }, /requires engine/u],
    [{ ...orcaConfig, velocityTimeConstant: 0.04 }, /not allowed/u],
    [{ ...orcaConfig, parameters: { ...orcaConfig.parameters, maxNeighbors: 1.5 } }, /integer/u],
    [{ ...orcaConfig, parameters: { ...orcaConfig.parameters, timeHorizon: 0 } }, /positive/u],
    [{ ...orcaConfig, parameters: { ...orcaConfig.parameters, relaxationTime: 0.5 } }, /not allowed/u],
    [{ ...socialForceConfig, engine: ORCA_ENGINE_ID }, /requires engine/u],
    [{ ...socialForceConfig, parameters: { ...socialForceConfig.parameters, relaxationTime: 0 } }, /positive/u],
    [{ ...socialForceConfig, parameters: { ...socialForceConfig.parameters, groupCoherenceFactor: 1 } }, /not allowed/u],
  ])("rejects invalid external-engine configuration %#", (value, message) => {
    expect(() => parseMethodConfig(value)).toThrow(message);
  });

  it("derives a stable hash-qualified key from canonical validated semantics", () => {
    const bytes = `${JSON.stringify(riemannianConfig, null, 2)}\n`;
    const config = parseMethodConfig(JSON.parse(bytes) as unknown);
    const identity = identifyMethod(config, bytes);
    const canonicalHash = sha256Bytes(serializeCanonicalMethodConfig(config));
    expect(identity.methodIdentityVersion).toBe(2);
    expect(identity.methodConfigCanonicalSha256).toBe(canonicalHash);
    expect(identity.methodConfigSourceSha256).toBe(sha256Bytes(bytes));
    expect(identity.methodConfigSha256).toBe(canonicalHash);
    expect(identity.methodKey).toBe(`${CONTROLLER_ID}--${canonicalHash.slice(0, 12)}`);
    expect(() => createMethodKey(CONTROLLER_ID, "not-a-hash")).toThrow(/SHA-256/u);
  });

  it("ignores LF/CRLF, whitespace, and generic parameter order but not values", () => {
    const variants = [
      `${JSON.stringify(riemannianConfig)}\n`,
      `${JSON.stringify(riemannianConfig, null, 4)}\r\n`,
      '{ "parameters": { "lambdaT": 1, "sigma": 2.4, "alpha": 10, "lambdaR": 10 }, "velocityTimeConstant": 0.04, "id": "conditioned_riemannian_metric_v1", "methodConfigVersion": 1 }\n',
    ];
    const keys = variants.map((source) => identifyMethod(parseMethodConfig(JSON.parse(source) as unknown), source).methodKey);
    expect(new Set(keys).size).toBe(1);
    const changed = { ...riemannianConfig, parameters: { ...riemannianConfig.parameters, alpha: 11 } };
    expect(identifyMethod(parseMethodConfig(changed), JSON.stringify(changed)).methodKey).not.toBe(keys[0]);
  });

  it("canonicalizes reordered version-2 generic parameters", () => {
    const sourceA = `${JSON.stringify(orcaConfig)}\n`;
    const sourceB = '{ "parameters": { "timeHorizonObst": 5, "maxNeighbors": 16, "neighborDist": 5, "timeHorizon": 5 }, "engine": "orca_rvo2_engine_v1", "id": "orca_rvo2_v1", "methodConfigVersion": 2 }\r\n';
    const keyA = identifyMethod(parseMethodConfig(JSON.parse(sourceA) as unknown), sourceA).methodKey;
    const keyB = identifyMethod(parseMethodConfig(JSON.parse(sourceB) as unknown), sourceB).methodKey;
    expect(keyB).toBe(keyA);
  });

  it.each([
    [{ ...riemannianConfig, methodConfigVersion: 3 }, /version/iu],
    [{ ...riemannianConfig, velocityTimeConstant: -1 }, /nonnegative/u],
    [{ ...riemannianConfig, parameters: { ...riemannianConfig.parameters, goalGain: 1 } }, /not allowed/u],
    [{ ...goalConfig, parameters: { alpha: 10 } }, /not allowed/u],
    [{ ...goalConfig, alpha: 10 }, /not allowed/u],
    [{ ...goalConfig, id: "unknown" }, /Unsupported/u],
  ])("strictly rejects invalid or cross-method fields", (value, message) => {
    expect(() => parseMethodConfig(value)).toThrow(message);
  });
});

type JsonObject = Record<string, unknown>;

function agents(value: JsonObject): JsonObject[] {
  return value.agents as JsonObject[];
}

function simulation(value: JsonObject): JsonObject {
  return value.simulation as JsonObject;
}

function correction(value: JsonObject): JsonObject {
  return simulation(value).correction as JsonObject;
}
