#!/usr/bin/env python3
"""Radius-aware repository adapter for the pinned PySocialForce simulator."""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

from radius_aware import install_radius_aware_social_force
from runner import (
    NATIVE_STEP_VERSION,
    first_segment_disk_intersection,
    load_pysocialforce,
    protocol_target,
    require_input,
)


RADIUS_RUNNER_VERSION = "pysocialforce_radius_runner_v1"


def run(input_path: Path, output_path: Path) -> None:
    import numpy as np  # pylint: disable=import-outside-toplevel

    data = require_input(json.loads(input_path.read_text(encoding="utf-8")))
    simulator_type = load_pysocialforce(Path(data["sourceDirectory"]).resolve())
    agents = sorted(data["agents"], key=lambda item: item["id"])
    radii = np.array([agent["radius"] for agent in agents], dtype=np.float64)
    if not np.all(np.isfinite(radii)) or np.any(radii < 0.0):
        raise RuntimeError("PySocialForce radius-aware runner requires finite nonnegative radii")
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
    install_radius_aware_social_force(simulator, radii)
    parameters = data["parameters"]
    preferred_speeds = np.array([agent["preferredSpeed"] for agent in agents], dtype=np.float64)
    simulator.peds.initial_speeds = preferred_speeds.copy()
    simulator.peds.max_speeds = preferred_speeds * parameters["maxSpeedMultiplier"]
    goals = np.array([agent["goal"] for agent in agents], dtype=np.float64)
    arrived = [False] * len(agents)
    goal_tolerance = float(data["goalTolerance"])
    dt = float(data["dt"])
    navigation = data["navigation"]

    with output_path.open("w", encoding="utf-8", newline="\n") as output:
        for step_index in range(int(data["steps"])):
            before_positions = simulator.peds.pos().copy()
            before_velocities = simulator.peds.vel().copy()
            _require_finite_state("before integration", step_index, before_positions, before_velocities)
            navigation_targets = []
            for index, agent in enumerate(agents):
                target = protocol_target(navigation, before_positions[index], agent["goal"])
                navigation_targets.append(target)
                if not arrived[index]:
                    distance = np.linalg.norm(before_positions[index] - np.array(agent["goal"]))
                    if distance <= goal_tolerance:
                        arrived[index] = True
                if arrived[index]:
                    simulator.peds.state[index, 2:4] = 0.0
                    # Preserve the legacy completion-v2 wrapper behavior.
                    simulator.peds.state[index, 4:6] = before_positions[index]
                else:
                    simulator.peds.state[index, 4:6] = np.array(target, dtype=np.float64)
            simulator.step_once()
            proposed_positions = simulator.peds.pos().copy()
            command_velocities = simulator.peds.vel().copy()
            _require_finite_state(
                "after integration", step_index, proposed_positions, command_velocities
            )
            for index in range(len(agents)):
                if arrived[index]:
                    simulator.peds.state[index, 4:6] = goals[index]
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
                    raise RuntimeError(
                        f"Non-finite radius-aware PySocialForce state at step {step_index} "
                        f"for agent {agent['id']}: {values}"
                    )
                output_agents.append(
                    {
                        "id": agent["id"],
                        "positionBefore": before_positions[index].tolist(),
                        "velocityBefore": before_velocities[index].tolist(),
                        "proposedPosition": final_position.tolist(),
                        "navigationTarget": navigation_targets[index],
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


def _require_finite_state(label, step_index, positions, velocities):
    import numpy as np  # pylint: disable=import-outside-toplevel

    if not np.all(np.isfinite(positions)) or not np.all(np.isfinite(velocities)):
        raise RuntimeError(
            f"Non-finite radius-aware PySocialForce {label} at step {step_index}: "
            f"positions={positions.tolist()}, velocities={velocities.tolist()}"
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", action="version", version=RADIUS_RUNNER_VERSION)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    arguments = parser.parse_args()
    try:
        run(Path(arguments.input), Path(arguments.output))
        return 0
    except Exception as error:  # pylint: disable=broad-except
        print(f"pysocialforce_radius_runner: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
