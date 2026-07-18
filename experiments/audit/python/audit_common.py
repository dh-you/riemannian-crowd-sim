"""Independent, standard-library-only helpers for the Stage D0 audit.

This module deliberately has no imports from the TypeScript implementation or
from third-party numerical packages.
"""

from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
from typing import Any, Iterable, Iterator, Sequence

Vec2 = tuple[float, float]


class AuditError(RuntimeError):
    """A fail-closed audit input or comparison error."""


def read_json(path: str | Path) -> Any:
    with Path(path).open("r", encoding="utf-8") as handle:
        value = json.load(handle)
    require_finite(value, str(path))
    return value


def write_json(path: str | Path, value: Any) -> None:
    require_finite(value, "output")
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, indent=2, sort_keys=True, allow_nan=False)
        handle.write("\n")


def iter_jsonl(path: str | Path) -> Iterator[tuple[int, Any]]:
    with Path(path).open("r", encoding="utf-8") as handle:
        for line_number, raw in enumerate(handle, start=1):
            text = raw.strip()
            if not text:
                continue
            try:
                value = json.loads(text)
            except json.JSONDecodeError as error:
                raise AuditError(f"{path}:{line_number}: malformed JSON: {error}") from error
            require_finite(value, f"{path}:{line_number}")
            yield line_number, value


def write_jsonl(path: str | Path, values: Iterable[Any]) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("w", encoding="utf-8", newline="\n") as handle:
        for value in values:
            require_finite(value, "JSONL output")
            handle.write(json.dumps(value, separators=(",", ":"), allow_nan=False))
            handle.write("\n")


def sha256_file(path: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(65536), b""):
            digest.update(block)
    return digest.hexdigest()


def require_finite(value: Any, path: str) -> None:
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return
    if isinstance(value, (int, float)):
        if not math.isfinite(float(value)):
            raise AuditError(f"{path}: non-finite number")
        return
    if isinstance(value, list):
        for index, entry in enumerate(value):
            require_finite(entry, f"{path}[{index}]")
        return
    if isinstance(value, dict):
        for key, entry in value.items():
            require_finite(entry, f"{path}.{key}")
        return
    raise AuditError(f"{path}: unsupported value type {type(value).__name__}")


def vec(value: Any, path: str) -> Vec2:
    if not isinstance(value, list) or len(value) != 2:
        raise AuditError(f"{path}: expected a two-number vector")
    if any(isinstance(entry, bool) or not isinstance(entry, (int, float)) for entry in value):
        raise AuditError(f"{path}: expected a two-number vector")
    result = (float(value[0]), float(value[1]))
    if not all(math.isfinite(entry) for entry in result):
        raise AuditError(f"{path}: vector is non-finite")
    return result


def add(first: Vec2, second: Vec2) -> Vec2:
    return (first[0] + second[0], first[1] + second[1])


def sub(first: Vec2, second: Vec2) -> Vec2:
    return (first[0] - second[0], first[1] - second[1])


def scale(value: Vec2, factor: float) -> Vec2:
    return (value[0] * factor, value[1] * factor)


def dot(first: Vec2, second: Vec2) -> float:
    return first[0] * second[0] + first[1] * second[1]


def norm(value: Vec2) -> float:
    return math.hypot(value[0], value[1])


def distance(first: Vec2, second: Vec2) -> float:
    return norm(sub(first, second))


def closest_point_on_segment(point: Vec2, start: Vec2, end: Vec2) -> Vec2:
    segment = sub(end, start)
    length_squared = dot(segment, segment)
    if length_squared == 0.0:
        return start
    fraction = max(0.0, min(1.0, dot(sub(point, start), segment) / length_squared))
    return add(start, scale(segment, fraction))


def wall_clearance(position: Vec2, radius: float, wall: dict[str, Any]) -> float:
    start = vec(wall.get("start"), "wall.start")
    end = vec(wall.get("end"), "wall.end")
    thickness = number(wall.get("thickness"), "wall.thickness", minimum=0.0)
    centerline_distance = distance(position, closest_point_on_segment(position, start, end))
    return centerline_distance - radius - thickness / 2.0


def constant_velocity_ttc(relative_position: Vec2, relative_velocity: Vec2, radius: float) -> float | None:
    """Earliest nonnegative root of |r + t v| = radius."""
    if radius < 0.0 or not math.isfinite(radius):
        raise AuditError("TTC radius must be finite and nonnegative")
    c = dot(relative_position, relative_position) - radius * radius
    if c <= 0.0:
        return 0.0
    a = dot(relative_velocity, relative_velocity)
    if a == 0.0:
        return None
    b = 2.0 * dot(relative_position, relative_velocity)
    if b >= 0.0:
        return None
    discriminant = b * b - 4.0 * a * c
    if discriminant < 0.0:
        return None
    first_root = (-b - math.sqrt(discriminant)) / (2.0 * a)
    return first_root if first_root >= 0.0 else None


def deflection_degrees(command: Vec2, goal_offset: Vec2) -> float | None:
    command_speed = norm(command)
    goal_distance = norm(goal_offset)
    if command_speed == 0.0 or goal_distance == 0.0:
        return None
    cosine = max(-1.0, min(1.0, dot(command, goal_offset) / (command_speed * goal_distance)))
    return math.degrees(math.acos(cosine))


def number(value: Any, path: str, minimum: float | None = None, positive: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise AuditError(f"{path}: expected a number")
    result = float(value)
    if not math.isfinite(result):
        raise AuditError(f"{path}: expected a finite number")
    if minimum is not None and result < minimum:
        raise AuditError(f"{path}: must be at least {minimum}")
    if positive and result <= 0.0:
        raise AuditError(f"{path}: must be positive")
    return result


def integer(value: Any, path: str, minimum: int | None = None) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise AuditError(f"{path}: expected an integer")
    if minimum is not None and value < minimum:
        raise AuditError(f"{path}: must be at least {minimum}")
    return value


def require_object(value: Any, path: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise AuditError(f"{path}: expected an object")
    return value


def load_scenario(path: str | Path) -> dict[str, Any]:
    scenario = require_object(read_json(path), "scenario")
    if scenario.get("experimentScenarioVersion") != 1:
        raise AuditError("scenario: unsupported experimentScenarioVersion")
    simulation = require_object(scenario.get("simulation"), "scenario.simulation")
    number(simulation.get("dt"), "scenario.simulation.dt", positive=True)
    number(simulation.get("horizonSeconds"), "scenario.simulation.horizonSeconds", minimum=0.0)
    number(simulation.get("goalTolerance"), "scenario.simulation.goalTolerance", minimum=0.0)
    agents = scenario.get("agents")
    walls = scenario.get("walls")
    if not isinstance(agents, list) or not agents:
        raise AuditError("scenario.agents: expected a nonempty array")
    if not isinstance(walls, list):
        raise AuditError("scenario.walls: expected an array")
    ids: list[int] = []
    for index, raw in enumerate(agents):
        agent = require_object(raw, f"scenario.agents[{index}]")
        ids.append(integer(agent.get("id"), f"scenario.agents[{index}].id"))
        vec(agent.get("position"), f"scenario.agents[{index}].position")
        vec(agent.get("velocity"), f"scenario.agents[{index}].velocity")
        vec(agent.get("goal"), f"scenario.agents[{index}].goal")
        number(agent.get("radius"), f"scenario.agents[{index}].radius", positive=True)
        number(agent.get("preferredSpeed"), f"scenario.agents[{index}].preferredSpeed", positive=True)
    if ids != sorted(ids) or len(ids) != len(set(ids)):
        raise AuditError("scenario agents must have unique ascending IDs")
    for index, raw in enumerate(walls):
        wall = require_object(raw, f"scenario.walls[{index}]")
        integer(wall.get("id"), f"scenario.walls[{index}].id")
        start = vec(wall.get("start"), f"scenario.walls[{index}].start")
        end = vec(wall.get("end"), f"scenario.walls[{index}].end")
        if start == end:
            raise AuditError(f"scenario.walls[{index}]: degenerate segment")
        number(wall.get("thickness"), f"scenario.walls[{index}].thickness", minimum=0.0)
    return scenario


def validate_step_stream(scenario: dict[str, Any], records: Sequence[dict[str, Any]]) -> None:
    dt = number(scenario["simulation"]["dt"], "scenario.simulation.dt", positive=True)
    expected_ids = [int(agent["id"]) for agent in scenario["agents"]]
    previous_positions = {int(agent["id"]): vec(agent["position"], "scenario.position") for agent in scenario["agents"]}
    for index, record in enumerate(records):
        if record.get("engineStepVersion") != 1:
            raise AuditError(f"step {index}: unsupported engineStepVersion")
        if integer(record.get("stepIndex"), f"step {index}.stepIndex", minimum=0) != index:
            raise AuditError(f"step {index}: missing, duplicate, or out-of-order step")
        time = number(record.get("time"), f"step {index}.time", minimum=0.0)
        expected_time = (index + 1) * dt
        if not close(time, expected_time, 1e-9, 1e-9):
            raise AuditError(f"step {index}: time {time} != expected {expected_time}")
        agents = record.get("agents")
        if not isinstance(agents, list):
            raise AuditError(f"step {index}.agents: expected an array")
        ids = [integer(require_object(agent, f"step {index}.agent").get("id"), "agent.id") for agent in agents]
        if ids != expected_ids:
            raise AuditError(f"step {index}: agent IDs are missing, duplicate, or out of order: {ids}")
        for agent in agents:
            agent_id = int(agent["id"])
            before = vec(agent.get("positionBefore"), f"step {index}.agent {agent_id}.positionBefore")
            tolerance = 2e-7 * max(1.0, abs(before[0]), abs(before[1]), abs(previous_positions[agent_id][0]), abs(previous_positions[agent_id][1]))
            if distance(before, previous_positions[agent_id]) > tolerance:
                raise AuditError(f"step {index}: agent {agent_id} trajectory is discontinuous")
            vec(agent.get("velocityBefore"), f"step {index}.agent {agent_id}.velocityBefore")
            vec(agent.get("preCorrectionPosition"), f"step {index}.agent {agent_id}.preCorrectionPosition")
            post = vec(agent.get("postCorrectionPosition"), f"step {index}.agent {agent_id}.postCorrectionPosition")
            vec(agent.get("commandVelocity"), f"step {index}.agent {agent_id}.commandVelocity")
            realized = vec(agent.get("realizedVelocity"), f"step {index}.agent {agent_id}.realizedVelocity")
            expected_velocity = scale(sub(post, before), 1.0 / dt)
            velocity_tolerance = 2e-7 * max(1.0, norm(expected_velocity), norm(realized))
            if distance(realized, expected_velocity) > velocity_tolerance:
                raise AuditError(f"step {index}: agent {agent_id} realized velocity is inconsistent with displacement")
            if not isinstance(agent.get("arrived"), bool):
                raise AuditError(f"step {index}: agent {agent_id} arrived must be boolean")
            previous_positions[agent_id] = post


def close(first: float, second: float, absolute: float, relative: float) -> bool:
    return abs(first - second) <= max(absolute, relative * max(abs(first), abs(second)))


def mean(values: Sequence[float]) -> float | None:
    return sum(values) / len(values) if values else None


def median(values: Sequence[float]) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2.0


def minimum_optional(current: float | None, candidate: float | None) -> float | None:
    if candidate is None:
        return current
    return candidate if current is None else min(current, candidate)
