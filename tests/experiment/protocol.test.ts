import { describe, expect, it } from "vitest";
import { generateFreeSpaceScenario } from "../../experiments/generation/freeSpace";
import {
  controllerParametersFromMethod,
  parseMethodConfig,
} from "../../experiments/protocol/methodConfig";
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

  it.each([
    [{ ...riemannianConfig, methodConfigVersion: 2 }, /version/iu],
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
