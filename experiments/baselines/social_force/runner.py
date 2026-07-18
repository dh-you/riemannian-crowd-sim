#!/usr/bin/env python3
"""Pinned PySocialForce command-line adapter; no plotting modules are imported."""

from __future__ import annotations

import argparse
import json
import logging
import math
import sys
import types
from pathlib import Path
from typing import Any


RUNNER_INPUT_VERSION = 1
NATIVE_STEP_VERSION = 1


def load_pysocialforce(source_directory: Path):
    package_directory = source_directory / "pysocialforce"
    if not package_directory.is_dir():
        raise RuntimeError(f"PySocialForce package is missing: {package_directory}")
    package = types.ModuleType("pysocialforce")
    package.__path__ = [str(package_directory)]
    package.__package__ = "pysocialforce"
    sys.modules["pysocialforce"] = package
    from pysocialforce.simulator import Simulator  # pylint: disable=import-outside-toplevel
    # The pinned project configures its package logger at DEBUG during import.
    # Baseline diagnostics belong on stderr only when they are actionable.
    logging.getLogger().setLevel(logging.WARNING)

    return Simulator


def first_segment_disk_intersection(start, end, center, radius):
    sx, sy = start[0] - center[0], start[1] - center[1]
    if math.hypot(sx, sy) <= radius:
        return [start[0], start[1]]
    dx, dy = end[0] - start[0], end[1] - start[1]
    a = dx * dx + dy * dy
    if a <= 0.0:
        return None
    b = 2.0 * (sx * dx + sy * dy)
    c = sx * sx + sy * sy - radius * radius
    discriminant = b * b - 4.0 * a * c
    if discriminant < 0.0:
        return None
    root = math.sqrt(max(0.0, discriminant))
    roots = [(-b - root) / (2.0 * a), (-b + root) / (2.0 * a)]
    valid = [value for value in roots if 0.0 <= value <= 1.0]
    if not valid:
        return None
    parameter = min(valid)
    return [start[0] + parameter * dx, start[1] + parameter * dy]


def require_input(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("runnerInputVersion") != RUNNER_INPUT_VERSION:
        raise RuntimeError("Unsupported PySocialForce runner input")
    if not isinstance(value.get("agents"), list) or not value["agents"]:
        raise RuntimeError("PySocialForce runner requires agents")
    if not isinstance(value.get("obstacles"), list):
        raise RuntimeError("PySocialForce runner requires an obstacle list")
    return value


def run(input_path: Path, output_path: Path) -> None:
    import numpy as np  # pylint: disable=import-outside-toplevel

    data = require_input(json.loads(input_path.read_text(encoding="utf-8")))
    simulator_type = load_pysocialforce(Path(data["sourceDirectory"]).resolve())
    agents = sorted(data["agents"], key=lambda item: item["id"])
    state = np.array(
        [
            [
                agent["position"][0],
                agent["position"][1],
                agent["velocity"][0],
                agent["velocity"][1],
                agent["goal"][0],
                agent["goal"][1],
            ]
            for agent in agents
        ],
        dtype=np.float64,
    )
    simulator = simulator_type(
        state,
        groups=[],
        obstacles=np.array(data["obstacles"], dtype=np.float64),
        config_file=str(Path(data["configPath"]).resolve()),
    )
    parameters = data["parameters"]
    preferred_speeds = np.array([agent["preferredSpeed"] for agent in agents], dtype=np.float64)
    simulator.peds.initial_speeds = preferred_speeds.copy()
    simulator.peds.max_speeds = preferred_speeds * parameters["maxSpeedMultiplier"]
    arrived = [False] * len(agents)
    goal_tolerance = float(data["goalTolerance"])
    dt = float(data["dt"])

    with output_path.open("w", encoding="utf-8", newline="\n") as output:
        for step_index in range(int(data["steps"])):
            before_positions = simulator.peds.pos().copy()
            before_velocities = simulator.peds.vel().copy()
            for index, agent in enumerate(agents):
                if not arrived[index]:
                    distance = np.linalg.norm(before_positions[index] - np.array(agent["goal"]))
                    if distance <= goal_tolerance:
                        arrived[index] = True
                if arrived[index]:
                    simulator.peds.state[index, 2:4] = 0.0
            simulator.step_once()
            proposed_positions = simulator.peds.pos().copy()
            command_velocities = simulator.peds.vel().copy()
            output_agents = []
            for index, agent in enumerate(agents):
                final_position = proposed_positions[index].copy()
                if arrived[index]:
                    final_position = before_positions[index].copy()
                else:
                    intersection = first_segment_disk_intersection(
                        before_positions[index],
                        proposed_positions[index],
                        agent["goal"],
                        goal_tolerance,
                    )
                    if intersection is not None:
                        final_position = np.array(intersection, dtype=np.float64)
                        arrived[index] = True
                realized_velocity = (final_position - before_positions[index]) / dt
                simulator.peds.state[index, 0:2] = final_position
                simulator.peds.state[index, 2:4] = 0.0 if arrived[index] else realized_velocity
                values = [
                    *before_positions[index],
                    *before_velocities[index],
                    *final_position,
                    *command_velocities[index],
                    *realized_velocity,
                ]
                if not all(math.isfinite(float(value)) for value in values):
                    raise RuntimeError(f"Non-finite PySocialForce state for agent {agent['id']}")
                output_agents.append(
                    {
                        "id": agent["id"],
                        "positionBefore": before_positions[index].tolist(),
                        "velocityBefore": before_velocities[index].tolist(),
                        "proposedPosition": final_position.tolist(),
                        "commandVelocity": command_velocities[index].tolist(),
                        "realizedVelocity": realized_velocity.tolist(),
                        "arrived": arrived[index],
                    }
                )
            record = {
                "nativeEngineStepVersion": NATIVE_STEP_VERSION,
                "stepIndex": step_index,
                "time": (step_index + 1) * dt,
                "agents": output_agents,
            }
            output.write(json.dumps(record, allow_nan=False, separators=(",", ":"), sort_keys=True))
            output.write("\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", action="version", version="pysocialforce_runner_v1")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    arguments = parser.parse_args()
    try:
        run(Path(arguments.input), Path(arguments.output))
        return 0
    except Exception as error:  # pylint: disable=broad-except
        print(f"pysocialforce_runner: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
