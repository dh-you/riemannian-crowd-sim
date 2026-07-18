"""Independently recompute Stage D0 metrics from physical engine-step records."""

from __future__ import annotations

import argparse
import math
from pathlib import Path
from typing import Any

from audit_common import (
    AuditError,
    constant_velocity_ttc,
    deflection_degrees,
    distance,
    iter_jsonl,
    load_scenario,
    mean,
    median,
    minimum_optional,
    norm,
    number,
    scale,
    sub,
    validate_step_stream,
    vec,
    wall_clearance,
    write_json,
)

CORRECTION_RATIO_EPSILON_METERS = 1e-12
AVOIDANCE_THRESHOLD_DEGREES = 5.0


def contact_measurements(
    scenario: dict[str, Any], positions: dict[int, tuple[float, float]]
) -> dict[str, float | int | None]:
    agents = scenario["agents"]
    walls = scenario["walls"]
    overlap_pairs = 0
    minimum_agent: float | None = None
    maximum_agent_penetration = 0.0
    for first_index, first in enumerate(agents):
        for second in agents[first_index + 1 :]:
            clearance = (
                distance(positions[int(first["id"])], positions[int(second["id"])])
                - float(first["radius"])
                - float(second["radius"])
            )
            minimum_agent = minimum_optional(minimum_agent, clearance)
            if clearance < 0.0:
                overlap_pairs += 1
                maximum_agent_penetration = max(maximum_agent_penetration, -clearance)
    wall_contacts = 0
    minimum_wall: float | None = None
    maximum_wall_penetration = 0.0
    for agent in agents:
        position = positions[int(agent["id"])]
        for wall in walls:
            clearance = wall_clearance(position, float(agent["radius"]), wall)
            minimum_wall = minimum_optional(minimum_wall, clearance)
            if clearance < 0.0:
                wall_contacts += 1
                maximum_wall_penetration = max(maximum_wall_penetration, -clearance)
    return {
        "overlapPairs": overlap_pairs,
        "wallContacts": wall_contacts,
        "minimumAgentClearance": minimum_agent,
        "minimumWallClearance": minimum_wall,
        "maximumAgentPenetration": maximum_agent_penetration,
        "maximumWallPenetration": maximum_wall_penetration,
    }


def evaluate(scenario: dict[str, Any], records: list[dict[str, Any]]) -> dict[str, Any]:
    validate_step_stream(scenario, records)
    dt = float(scenario["simulation"]["dt"])
    definitions = {int(agent["id"]): agent for agent in scenario["agents"]}
    accumulators: dict[int, dict[str, Any]] = {}
    for agent_id, agent in definitions.items():
        accumulators[agent_id] = {
            "previousPosition": vec(agent["position"], "agent.position"),
            "previousVelocity": vec(agent["velocity"], "agent.velocity"),
            "previousAcceleration": None,
            "pathLength": 0.0,
            "firstArrivalTime": None,
        }

    minimum_agent: float | None = None
    minimum_wall: float | None = None
    pre_overlap_seconds = 0.0
    post_overlap_seconds = 0.0
    max_pre_agent = max_pre_wall = max_post_agent = max_post_wall = 0.0
    total_intended = total_correction = 0.0
    acceleration_squared = jerk_squared = 0.0
    acceleration_count = jerk_count = 0
    pairwise_pre_center = pairwise_pre_clearance = None
    pairwise_post_center = pairwise_post_clearance = None
    onset: dict[int, dict[str, float | None]] = {}

    for record in records:
        agents = record["agents"]
        step_by_id = {int(agent["id"]): agent for agent in agents}
        pre_positions = {
            agent_id: vec(agent["preCorrectionPosition"], "preCorrectionPosition")
            for agent_id, agent in step_by_id.items()
        }
        post_positions = {
            agent_id: vec(agent["postCorrectionPosition"], "postCorrectionPosition")
            for agent_id, agent in step_by_id.items()
        }
        pre = contact_measurements(scenario, pre_positions)
        post = contact_measurements(scenario, post_positions)
        minimum_agent = minimum_optional(minimum_agent, pre["minimumAgentClearance"])
        minimum_wall = minimum_optional(minimum_wall, pre["minimumWallClearance"])
        pre_overlap_seconds += int(pre["overlapPairs"]) * dt
        post_overlap_seconds += int(post["overlapPairs"]) * dt
        max_pre_agent = max(max_pre_agent, float(pre["maximumAgentPenetration"]))
        max_pre_wall = max(max_pre_wall, float(pre["maximumWallPenetration"]))
        max_post_agent = max(max_post_agent, float(post["maximumAgentPenetration"]))
        max_post_wall = max(max_post_wall, float(post["maximumWallPenetration"]))

        arrived_before = {
            agent_id for agent_id, accumulated in accumulators.items()
            if accumulated["firstArrivalTime"] is not None
        }
        for agent_id, step in step_by_id.items():
            before = vec(step["positionBefore"], "positionBefore")
            pre_position = pre_positions[agent_id]
            post_position = post_positions[agent_id]
            total_intended += distance(pre_position, before)
            total_correction += distance(post_position, pre_position)
            accumulated = accumulators[agent_id]
            if accumulated["firstArrivalTime"] is None:
                accumulated["pathLength"] += distance(post_position, accumulated["previousPosition"])
                realized = vec(step["realizedVelocity"], "realizedVelocity")
                acceleration = scale(sub(realized, accumulated["previousVelocity"]), 1.0 / dt)
                acceleration_squared += acceleration[0] ** 2 + acceleration[1] ** 2
                acceleration_count += 1
                previous_acceleration = accumulated["previousAcceleration"]
                if previous_acceleration is not None:
                    jerk = scale(sub(acceleration, previous_acceleration), 1.0 / dt)
                    jerk_squared += jerk[0] ** 2 + jerk[1] ** 2
                    jerk_count += 1
                accumulated["previousAcceleration"] = acceleration
                if step["arrived"]:
                    accumulated["firstArrivalTime"] = float(record["time"])
            accumulated["previousPosition"] = post_position
            accumulated["previousVelocity"] = vec(step["realizedVelocity"], "realizedVelocity")

        if scenario.get("family") == "pairwise" and len(agents) == 2:
            first, second = agents
            first_id = int(first["id"])
            second_id = int(second["id"])
            combined_radius = float(definitions[first_id]["radius"]) + float(definitions[second_id]["radius"])
            pre_center = distance(pre_positions[first_id], pre_positions[second_id])
            post_center = distance(post_positions[first_id], post_positions[second_id])
            pairwise_pre_center = minimum_optional(pairwise_pre_center, pre_center)
            pairwise_pre_clearance = minimum_optional(pairwise_pre_clearance, pre_center - combined_radius)
            pairwise_post_center = minimum_optional(pairwise_post_center, post_center)
            pairwise_post_clearance = minimum_optional(pairwise_post_clearance, post_center - combined_radius)
            for controlled, other in ((first, second), (second, first)):
                controlled_id = int(controlled["id"])
                if controlled_id in arrived_before or controlled_id in onset:
                    continue
                command = vec(controlled["commandVelocity"], "commandVelocity")
                controlled_before = vec(controlled["positionBefore"], "positionBefore")
                goal_offset = sub(vec(definitions[controlled_id]["goal"], "goal"), controlled_before)
                deflection = deflection_degrees(command, goal_offset)
                if deflection is None or deflection <= AVOIDANCE_THRESHOLD_DEGREES:
                    continue
                other_id = int(other["id"])
                relative_position = sub(vec(other["positionBefore"], "positionBefore"), controlled_before)
                relative_velocity = sub(
                    vec(other["velocityBefore"], "velocityBefore"),
                    vec(controlled["velocityBefore"], "velocityBefore"),
                )
                onset[controlled_id] = {
                    "time": max(0.0, float(record["time"]) - dt),
                    "ttc": constant_velocity_ttc(
                        relative_position,
                        relative_velocity,
                        float(definitions[controlled_id]["radius"]) + float(definitions[other_id]["radius"]),
                    ),
                }

    duration = float(records[-1]["time"]) if records else 0.0
    per_agent: list[dict[str, Any]] = []
    for agent_id in sorted(definitions):
        definition = definitions[agent_id]
        accumulated = accumulators[agent_id]
        direct_distance = distance(vec(definition["position"], "position"), vec(definition["goal"], "goal"))
        ideal_time = direct_distance / float(definition["preferredSpeed"])
        arrival = accumulated["firstArrivalTime"]
        per_agent.append({
            "id": agent_id,
            "firstArrivalTime": arrival,
            "normalizedTravelTime": None if arrival is None or ideal_time <= 0.0 else arrival / ideal_time,
            "pathEfficiency": None if arrival is None or direct_distance <= 0.0 else accumulated["pathLength"] / direct_distance,
        })
    reached = sum(entry["firstArrivalTime"] is not None for entry in per_agent)
    normalized_times = [entry["normalizedTravelTime"] for entry in per_agent if entry["normalizedTravelTime"] is not None]
    efficiencies = [entry["pathEfficiency"] for entry in per_agent if entry["pathEfficiency"] is not None]
    final_arrived = sum(bool(agent["arrived"]) for agent in records[-1]["agents"]) if records else 0

    if not scenario["walls"]:
        total_agent_correction, total_wall_correction = total_correction, 0.0
    elif len(scenario["agents"]) == 1:
        total_agent_correction, total_wall_correction = 0.0, total_correction
    elif total_correction <= 1e-15:
        total_agent_correction = total_wall_correction = 0.0
    else:
        raise AuditError("independent agent/wall correction decomposition is ambiguous for mixed contact geometry")

    pairwise: dict[str, Any] | None = None
    if scenario.get("family") == "pairwise" and len(scenario["agents"]) == 2:
        pairwise = {
            "avoidanceThresholdDegrees": AVOIDANCE_THRESHOLD_DEGREES,
            "perAgent": [
                {
                    "id": agent_id,
                    "avoidanceOnsetTime": onset.get(agent_id, {}).get("time"),
                    "ttcAtAvoidanceOnset": onset.get(agent_id, {}).get("ttc"),
                }
                for agent_id in sorted(definitions)
            ],
            "minimumPreCorrectionCenterDistance": pairwise_pre_center,
            "minimumPreCorrectionPhysicalClearance": pairwise_pre_clearance,
            "minimumPostCorrectionCenterDistance": pairwise_post_center,
            "minimumPostCorrectionPhysicalClearance": pairwise_post_clearance,
        }

    return {
        "auditMetricsVersion": 1,
        "completion": {
            "agentsReachedGoal": reached,
            "successFraction": reached / len(definitions),
            "finalArrivedFraction": final_arrived / len(definitions),
            "perAgent": per_agent,
        },
        "travelTime": {
            "meanNormalizedTravelTime": mean(normalized_times),
            "medianNormalizedTravelTime": median(normalized_times),
        },
        "pathEfficiency": {
            "meanPathEfficiency": mean(efficiencies),
            "medianPathEfficiency": median(efficiencies),
        },
        "separation": {
            "minimumPreCorrectionAgentClearance": minimum_agent,
            "minimumPreCorrectionWallClearance": minimum_wall,
            "totalPreCorrectionOverlapPairSeconds": pre_overlap_seconds,
            "totalPostCorrectionOverlapPairSeconds": post_overlap_seconds,
            "preCorrectionOverlapPairSecondsPerAgentSecond": None if duration == 0.0 else pre_overlap_seconds / (len(definitions) * duration),
            "maximumPreCorrectionAgentPenetration": max_pre_agent,
            "maximumPreCorrectionWallPenetration": max_pre_wall,
            "maximumPostCorrectionAgentPenetration": max_post_agent,
            "maximumPostCorrectionWallPenetration": max_post_wall,
        },
        "correctionDependence": {
            "totalIntendedDisplacement": total_intended,
            "totalAgentCorrectionDisplacement": total_agent_correction,
            "totalWallCorrectionDisplacement": total_wall_correction,
            "totalCorrectionDisplacement": total_correction,
            "correctionRatio": total_correction / (total_intended + CORRECTION_RATIO_EPSILON_METERS),
        },
        "smoothness": {
            "rmsAcceleration": None if acceleration_count == 0 else math.sqrt(acceleration_squared / acceleration_count),
            "rmsJerk": None if jerk_count == 0 else math.sqrt(jerk_squared / jerk_count),
            "accelerationSampleCount": acceleration_count,
            "jerkSampleCount": jerk_count,
        },
        "throughput": None if duration == 0.0 else reached / duration,
        "pairwise": pairwise,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scenario", required=True)
    parser.add_argument("--trajectory", required=True)
    parser.add_argument("--out", required=True)
    arguments = parser.parse_args()
    try:
        scenario = load_scenario(arguments.scenario)
        records = [value for _, value in iter_jsonl(arguments.trajectory)]
        output = evaluate(scenario, records)
        write_json(arguments.out, output)
        print(f"independent metric audit wrote {arguments.out} ({len(records)} steps)")
        return 0
    except (AuditError, OSError, ValueError, KeyError, TypeError) as error:
        print(f"independent metric audit failed: {error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
