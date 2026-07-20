#!/usr/bin/env python3
"""Strict JuPedSim 1.4.2 SocialForceModel JSON/JSONL adapter."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import math
import platform
import sys
from pathlib import Path
from typing import Any


RUNNER_INPUT_VERSION = 1
RUNNER_METADATA_VERSION = 1
NATIVE_STEP_VERSION = 2
EXPECTED_JUPEDSIM_VERSION = "1.4.2"


def exact_object(value: Any, keys: set[str], path: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise RuntimeError(f"{path} must be an object")
    actual = set(value)
    missing = sorted(keys - actual)
    extra = sorted(actual - keys)
    if missing:
        raise RuntimeError(f"{path} is missing fields: {', '.join(missing)}")
    if extra:
        raise RuntimeError(f"{path} has unexpected fields: {', '.join(extra)}")
    return value


def finite(value: Any, path: str, *, positive: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RuntimeError(f"{path} must be a number")
    result = float(value)
    if not math.isfinite(result):
        raise RuntimeError(f"{path} must be finite")
    if positive and result <= 0:
        raise RuntimeError(f"{path} must be positive")
    return result


def integer(value: Any, path: str, *, positive: bool = False) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise RuntimeError(f"{path} must be an integer")
    if positive and value <= 0:
        raise RuntimeError(f"{path} must be positive")
    return value


def vector(value: Any, path: str) -> tuple[float, float]:
    if not isinstance(value, list) or len(value) != 2:
        raise RuntimeError(f"{path} must be a two-element array")
    return (finite(value[0], f"{path}[0]"), finite(value[1], f"{path}[1]"))


def require_navigation(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise RuntimeError("navigation must be an object")
    if value.get("type") == "point_goal":
        return exact_object(value, {"type"}, "navigation")
    root = exact_object(value, {"type", "waypoint", "switchLine"}, "navigation")
    if root["type"] != "waypoint_then_point_goal":
        raise RuntimeError("navigation.type is unsupported")
    vector(root["waypoint"], "navigation.waypoint")
    line = exact_object(
        root["switchLine"],
        {"type", "axis", "threshold", "direction"},
        "navigation.switchLine",
    )
    if line["type"] != "directional_line":
        raise RuntimeError("navigation.switchLine.type must be directional_line")
    if line["axis"] not in {"x", "y"}:
        raise RuntimeError("navigation.switchLine.axis must be x or y")
    if line["direction"] not in {"positive", "negative"}:
        raise RuntimeError("navigation.switchLine.direction is invalid")
    finite(line["threshold"], "navigation.switchLine.threshold")
    return root


def require_geometry(value: Any) -> dict[str, Any]:
    root = exact_object(
        value,
        {"geometrySpecVersion", "margin", "outerPolygon", "excludedWallPolygons"},
        "geometry",
    )
    if root["geometrySpecVersion"] != 1:
        raise RuntimeError("Unsupported geometrySpecVersion")
    finite(root["margin"], "geometry.margin", positive=True)
    if not isinstance(root["outerPolygon"], list) or len(root["outerPolygon"]) != 4:
        raise RuntimeError("geometry.outerPolygon must have four vertices")
    for index, point in enumerate(root["outerPolygon"]):
        vector(point, f"geometry.outerPolygon[{index}]")
    if not isinstance(root["excludedWallPolygons"], list):
        raise RuntimeError("geometry.excludedWallPolygons must be an array")
    previous_wall_id: int | None = None
    for index, item in enumerate(root["excludedWallPolygons"]):
        wall = exact_object(item, {"wallId", "vertices"}, f"geometry.excludedWallPolygons[{index}]")
        wall_id = integer(wall["wallId"], f"geometry.excludedWallPolygons[{index}].wallId")
        if previous_wall_id is not None and wall_id <= previous_wall_id:
            raise RuntimeError("geometry wall polygons must have unique ascending IDs")
        previous_wall_id = wall_id
        if not isinstance(wall["vertices"], list) or len(wall["vertices"]) != 4:
            raise RuntimeError("each expanded wall polygon must have four vertices")
        for point_index, point in enumerate(wall["vertices"]):
            vector(point, f"geometry.excludedWallPolygons[{index}].vertices[{point_index}]")
    return root


def require_input(value: Any) -> dict[str, Any]:
    root = exact_object(
        value,
        {
            "runnerInputVersion",
            "methodId",
            "engineId",
            "scenarioFamily",
            "scenarioVariant",
            "dt",
            "steps",
            "goalTolerance",
            "completionSpecVersion",
            "parameters",
            "navigation",
            "geometry",
            "geometryCanonicalJson",
            "geometrySha256",
            "agents",
        },
        "input",
    )
    if root["runnerInputVersion"] != RUNNER_INPUT_VERSION:
        raise RuntimeError("Unsupported JuPedSim runner input")
    if root["methodId"] != "social_force_jupedsim_v1":
        raise RuntimeError("JuPedSim runner method ID mismatch")
    if root["engineId"] != "jupedsim_sfm_engine_v1":
        raise RuntimeError("JuPedSim runner engine ID mismatch")
    if not isinstance(root["scenarioFamily"], str) or not root["scenarioFamily"]:
        raise RuntimeError("scenarioFamily must be nonempty")
    if not isinstance(root["scenarioVariant"], str) or not root["scenarioVariant"]:
        raise RuntimeError("scenarioVariant must be nonempty")
    finite(root["dt"], "dt", positive=True)
    integer(root["steps"], "steps", positive=True)
    finite(root["goalTolerance"], "goalTolerance")
    if root["goalTolerance"] < 0:
        raise RuntimeError("goalTolerance must be nonnegative")
    if root["completionSpecVersion"] != 1:
        raise RuntimeError("Unsupported completionSpecVersion")
    parameters = exact_object(
        root["parameters"],
        {
            "bodyForce",
            "friction",
            "mass",
            "reactionTime",
            "agentScale",
            "obstacleScale",
            "forceDistance",
        },
        "parameters",
    )
    for key in parameters:
        finite(parameters[key], f"parameters.{key}", positive=True)
    require_navigation(root["navigation"])
    geometry = require_geometry(root["geometry"])
    if not isinstance(root["geometryCanonicalJson"], str):
        raise RuntimeError("geometryCanonicalJson must be a string")
    try:
        canonical_value = json.loads(root["geometryCanonicalJson"])
    except json.JSONDecodeError as error:
        raise RuntimeError("geometryCanonicalJson is invalid") from error
    if canonical_value != geometry:
        raise RuntimeError("geometryCanonicalJson does not match geometry")
    geometry_hash = hashlib.sha256(root["geometryCanonicalJson"].encode("utf-8")).hexdigest()
    if root["geometrySha256"] != geometry_hash:
        raise RuntimeError("geometrySha256 does not match canonical geometry")
    if not isinstance(root["agents"], list) or not root["agents"]:
        raise RuntimeError("JuPedSim runner requires agents")
    previous_id: int | None = None
    for index, item in enumerate(root["agents"]):
        agent = exact_object(
            item,
            {"id", "radius", "preferredSpeed", "position", "velocity", "goal"},
            f"agents[{index}]",
        )
        agent_id = integer(agent["id"], f"agents[{index}].id")
        if previous_id is not None and agent_id <= previous_id:
            raise RuntimeError("agent IDs must be unique and sorted ascending")
        previous_id = agent_id
        finite(agent["radius"], f"agents[{index}].radius", positive=True)
        finite(agent["preferredSpeed"], f"agents[{index}].preferredSpeed", positive=True)
        vector(agent["position"], f"agents[{index}].position")
        vector(agent["velocity"], f"agents[{index}].velocity")
        vector(agent["goal"], f"agents[{index}].goal")
    return root


def protocol_target(
    navigation: dict[str, Any],
    position: tuple[float, float],
    point_goal: tuple[float, float],
) -> tuple[float, float]:
    if navigation["type"] == "point_goal":
        return point_goal
    line = navigation["switchLine"]
    coordinate = position[0 if line["axis"] == "x" else 1]
    switched = (
        coordinate > float(line["threshold"])
        if line["direction"] == "positive"
        else coordinate < float(line["threshold"])
    )
    return point_goal if switched else vector(navigation["waypoint"], "navigation.waypoint")


def normalized_orientation(
    velocity: tuple[float, float],
    position: tuple[float, float],
    target: tuple[float, float],
) -> tuple[float, float]:
    candidate = velocity
    magnitude = math.hypot(*candidate)
    if magnitude <= 1e-12:
        candidate = (target[0] - position[0], target[1] - position[1])
        magnitude = math.hypot(*candidate)
    if magnitude <= 1e-12:
        return (1.0, 0.0)
    return (candidate[0] / magnitude, candidate[1] / magnitude)


def build_walkable_geometry(data: dict[str, Any]):
    import shapely
    from shapely.geometry import Point, Polygon
    from shapely.ops import unary_union

    geometry = data["geometry"]
    outer = Polygon(geometry["outerPolygon"])
    if not outer.is_valid or outer.area <= 0:
        raise RuntimeError("outer walkable polygon is invalid")
    excluded = [Polygon(item["vertices"]) for item in geometry["excludedWallPolygons"]]
    if any(not polygon.is_valid or polygon.area <= 0 for polygon in excluded):
        raise RuntimeError("expanded wall polygon is invalid")
    walkable = outer.difference(unary_union(excluded)) if excluded else outer
    components = list(walkable.geoms) if walkable.geom_type == "MultiPolygon" else [walkable]
    components = sorted(
        components,
        key=lambda polygon: (
            tuple(float(value) for value in polygon.bounds),
            float(polygon.area),
            shapely.to_wkb(polygon, byte_order=1).hex(),
        ),
    )
    initial_points = [Point(agent["position"]) for agent in data["agents"]]
    candidates = [
        polygon for polygon in components
        if all(polygon.contains(point) for point in initial_points)
    ]
    if len(candidates) != 1:
        raise RuntimeError("agents do not identify exactly one connected walkable component")
    selected = candidates[0]
    validation_points = [
        *(("initial position", agent["id"], Point(agent["position"])) for agent in data["agents"]),
        *(("point goal", agent["id"], Point(agent["goal"])) for agent in data["agents"]),
    ]
    if data["navigation"]["type"] == "waypoint_then_point_goal":
        validation_points.append(("protocol waypoint", None, Point(data["navigation"]["waypoint"])))
    for label, agent_id, point in validation_points:
        if not selected.contains(point):
            suffix = "" if agent_id is None else f" for agent {agent_id}"
            raise RuntimeError(f"{label}{suffix} is not valid walkable space")
    normalized = shapely.normalize(selected)
    final_hash = hashlib.sha256(shapely.to_wkb(normalized, byte_order=1)).hexdigest()
    return selected, {
        "componentCount": len(components),
        "selectedArea": float(selected.area),
        "selectedBounds": [float(value) for value in selected.bounds],
        "finalGeometrySha256": final_hash,
    }


def package_info() -> dict[str, Any]:
    import jupedsim

    distribution = importlib.metadata.distribution("jupedsim")
    license_path = Path(distribution.locate_file("jupedsim-1.4.2.dist-info/licenses/LICENSE"))
    license_bytes = license_path.read_bytes().replace(b"\r\n", b"\n")
    return {
        "jupedsimVersion": jupedsim.__version__,
        "pythonVersion": platform.python_version(),
        "pythonImplementation": platform.python_implementation(),
        "platform": platform.platform(),
        "architecture": platform.machine(),
        "upstreamProject": "JuPedSim",
        "upstreamRepository": "https://github.com/PedestrianDynamics/jupedsim",
        "upstreamLicense": "LGPL-3.0-or-later",
        "installedLicenseSha256": hashlib.sha256(license_bytes).hexdigest(),
    }


def run(input_path: Path, output_path: Path, metadata_path: Path) -> None:
    import jupedsim

    if jupedsim.__version__ != EXPECTED_JUPEDSIM_VERSION:
        raise RuntimeError(
            f"JuPedSim version mismatch: expected {EXPECTED_JUPEDSIM_VERSION}, "
            f"received {jupedsim.__version__}"
        )
    data = require_input(json.loads(input_path.read_text(encoding="utf-8")))
    walkable, geometry_metadata = build_walkable_geometry(data)
    parameters = data["parameters"]
    simulation = jupedsim.Simulation(
        model=jupedsim.SocialForceModel(
            body_force=float(parameters["bodyForce"]),
            friction=float(parameters["friction"]),
        ),
        geometry=walkable,
        dt=float(data["dt"]),
    )
    if not math.isclose(simulation.delta_time(), float(data["dt"]), rel_tol=0.0, abs_tol=1e-15):
        raise RuntimeError("JuPedSim did not preserve the scenario timestep")
    stage_id = simulation.add_direct_steering_stage()
    journey_id = simulation.add_journey(jupedsim.JourneyDescription([stage_id]))
    agents = data["agents"]
    scenario_to_jupedsim: dict[int, int] = {}
    jupedsim_to_scenario: dict[int, int] = {}
    point_goals: dict[int, tuple[float, float]] = {}
    arrived: dict[int, bool] = {}
    for definition in agents:
        scenario_id = int(definition["id"])
        position = vector(definition["position"], f"agent {scenario_id} position")
        velocity = vector(definition["velocity"], f"agent {scenario_id} velocity")
        goal = vector(definition["goal"], f"agent {scenario_id} goal")
        target = protocol_target(data["navigation"], position, goal)
        jupedsim_id = simulation.add_agent(
            jupedsim.SocialForceModelAgentParameters(
                position=position,
                orientation=normalized_orientation(velocity, position, target),
                journey_id=journey_id,
                stage_id=stage_id,
                velocity=velocity,
                mass=float(parameters["mass"]),
                desired_speed=float(definition["preferredSpeed"]),
                reaction_time=float(parameters["reactionTime"]),
                agent_scale=float(parameters["agentScale"]),
                obstacle_scale=float(parameters["obstacleScale"]),
                force_distance=float(parameters["forceDistance"]),
                radius=float(definition["radius"]),
            )
        )
        if scenario_id in scenario_to_jupedsim or jupedsim_id in jupedsim_to_scenario:
            raise RuntimeError("duplicate scenario or JuPedSim agent ID")
        scenario_to_jupedsim[scenario_id] = jupedsim_id
        jupedsim_to_scenario[jupedsim_id] = scenario_id
        point_goals[scenario_id] = goal
        arrived[scenario_id] = math.dist(position, goal) <= float(data["goalTolerance"])
    expected_scenario_ids = [int(agent["id"]) for agent in agents]
    expected_jupedsim_ids = set(jupedsim_to_scenario)
    if simulation.agent_count() != len(agents):
        raise RuntimeError("JuPedSim agent count mismatch after insertion")

    with output_path.open("w", encoding="utf-8", newline="\n") as output:
        for step_index in range(int(data["steps"])):
            before_native = list(simulation.agents())
            before_ids = {agent.id for agent in before_native}
            if before_ids != expected_jupedsim_ids or len(before_native) != len(agents):
                raise RuntimeError("JuPedSim agent set changed before a step")
            before_by_scenario = {
                jupedsim_to_scenario[agent.id]: {
                    "position": tuple(float(value) for value in agent.position),
                    "velocity": tuple(float(value) for value in agent.model.velocity),
                }
                for agent in before_native
            }
            targets: dict[int, tuple[float, float]] = {}
            for scenario_id in expected_scenario_ids:
                native_id = scenario_to_jupedsim[scenario_id]
                before = before_by_scenario[scenario_id]
                target = protocol_target(
                    data["navigation"],
                    before["position"],
                    point_goals[scenario_id],
                )
                targets[scenario_id] = target
                simulation.agent(native_id).target = target
            simulation.iterate()
            if simulation.removed_agents():
                raise RuntimeError("JuPedSim unexpectedly removed an agent")
            after_native = list(simulation.agents())
            after_ids = {agent.id for agent in after_native}
            if after_ids != expected_jupedsim_ids or len(after_native) != len(agents):
                raise RuntimeError("JuPedSim agent set changed after a step")
            after_by_scenario = {
                jupedsim_to_scenario[agent.id]: {
                    "position": tuple(float(value) for value in agent.position),
                    "velocity": tuple(float(value) for value in agent.model.velocity),
                }
                for agent in after_native
            }
            output_agents = []
            for scenario_id in expected_scenario_ids:
                before = before_by_scenario[scenario_id]
                after = after_by_scenario[scenario_id]
                values = [
                    *before["position"],
                    *before["velocity"],
                    *after["position"],
                    *after["velocity"],
                    *targets[scenario_id],
                ]
                if not all(math.isfinite(value) for value in values):
                    raise RuntimeError(f"non-finite JuPedSim state for agent {scenario_id}")
                arrived[scenario_id] = (
                    arrived[scenario_id]
                    or math.dist(after["position"], point_goals[scenario_id])
                    <= float(data["goalTolerance"])
                )
                output_agents.append(
                    {
                        "id": scenario_id,
                        "positionBefore": list(before["position"]),
                        "velocityBefore": list(before["velocity"]),
                        "proposedPosition": list(after["position"]),
                        "navigationTarget": list(targets[scenario_id]),
                        "commandVelocity": list(after["velocity"]),
                        "realizedVelocity": list(after["velocity"]),
                        "arrived": arrived[scenario_id],
                    }
                )
            record = {
                "nativeEngineStepVersion": NATIVE_STEP_VERSION,
                "stepIndex": step_index,
                "time": (step_index + 1) * float(data["dt"]),
                "agents": output_agents,
            }
            output.write(json.dumps(record, allow_nan=False, separators=(",", ":"), sort_keys=True))
            output.write("\n")

    if simulation.iteration_count() != int(data["steps"]):
        raise RuntimeError("JuPedSim iteration count mismatch")
    metadata = {
        "runnerMetadataVersion": RUNNER_METADATA_VERSION,
        **package_info(),
        **geometry_metadata,
        "geometrySha256": data["geometrySha256"],
        "directSteering": True,
        "journeyStageCount": 1,
        "dt": float(data["dt"]),
        "steps": int(data["steps"]),
        "agentCount": len(agents),
        "scenarioToJuPedSimIds": [
            {"scenarioId": scenario_id, "jupedsimId": scenario_to_jupedsim[scenario_id]}
            for scenario_id in expected_scenario_ids
        ],
    }
    metadata_path.write_text(
        json.dumps(metadata, allow_nan=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", action="store_true")
    parser.add_argument("--package-info", action="store_true")
    parser.add_argument("--input")
    parser.add_argument("--output")
    parser.add_argument("--metadata")
    arguments = parser.parse_args()
    try:
        if arguments.version:
            print(f"jupedsim_runner_v1 jupedsim={package_info()['jupedsimVersion']}")
            return 0
        if arguments.package_info:
            print(json.dumps(package_info(), allow_nan=False, sort_keys=True))
            return 0
        if not arguments.input or not arguments.output or not arguments.metadata:
            raise RuntimeError("--input, --output, and --metadata are required")
        run(Path(arguments.input), Path(arguments.output), Path(arguments.metadata))
        return 0
    except Exception as error:  # pylint: disable=broad-except
        print(f"jupedsim_runner: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
