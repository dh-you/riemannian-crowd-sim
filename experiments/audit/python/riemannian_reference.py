"""Independent standard-library reference for the published controller equations.

The implementation follows the equations directly and neither imports nor
executes repository TypeScript/JavaScript code.
"""

from __future__ import annotations

import argparse
import math
from typing import Any

from audit_common import AuditError, dot, iter_jsonl, norm, scale, sub, vec, write_jsonl

COINCIDENT_EPSILON_METERS = 1e-9


def smoothstep(lower: float, upper: float, value: float) -> float:
    if upper <= lower:
        raise AuditError("smoothstep interval must have positive width")
    t = max(0.0, min(1.0, (value - lower) / (upper - lower)))
    return 3.0 * t * t - 2.0 * t * t * t


def wendland_c2(scaled_distance: float) -> float:
    # phi(s) = (1 + 4s)(1 - s)^4 on [0, 1), and zero outside support.
    if scaled_distance < 0.0:
        raise AuditError("distance ratio must be nonnegative")
    if scaled_distance >= 1.0:
        return 0.0
    remainder = 1.0 - scaled_distance
    return (1.0 + 4.0 * scaled_distance) * remainder**4


def effective_metric(case: dict[str, Any]) -> tuple[list[list[float]], int]:
    controlled = case["controlled"]
    parameters = case["parameters"]
    alpha = float(parameters["alpha"])
    sigma = float(parameters["sigma"])
    lambda_r = float(parameters["lambdaR"])
    lambda_t = float(parameters["lambdaT"])
    if alpha < 0.0 or sigma <= 0.0 or lambda_r <= 0.0 or lambda_t <= 0.0:
        raise AuditError(f"{case['caseId']}: invalid controller parameters")

    position = vec(controlled["position"], "controlled.position")
    velocity = vec(controlled["velocity"], "controlled.velocity")
    goal = vec(controlled["goal"], "controlled.goal")
    speed = float(controlled["preferredSpeed"])
    goal_offset = sub(goal, position)
    goal_distance = norm(goal_offset)
    heading = (0.0, 0.0) if goal_distance == 0.0 else scale(goal_offset, 1.0 / goal_distance)
    matrix = [[1.0, 0.0], [0.0, 1.0]]
    skipped = 0

    for neighbor in sorted(case["neighbors"], key=lambda entry: int(entry["id"])):
        if int(neighbor["id"]) == int(controlled["id"]):
            continue
        relative = sub(vec(neighbor["position"], "neighbor.position"), position)
        distance = norm(relative)
        if distance >= sigma:
            continue
        if distance < COINCIDENT_EPSILON_METERS:
            skipped += 1
            continue
        radial = scale(relative, 1.0 / distance)
        distance_rate = dot(radial, sub(vec(neighbor["velocity"], "neighbor.velocity"), velocity))
        closing = smoothstep(0.0, speed, -distance_rate)
        visibility = 0.0 if goal_distance == 0.0 else smoothstep(-1.0, 1.0, dot(heading, radial))
        weight = alpha * wendland_c2(distance / sigma) * closing * visibility
        if weight == 0.0:
            continue
        # A = lambda_t I + (lambda_r-lambda_t) r_hat r_hat^T.
        delta = lambda_r - lambda_t
        tensor = [
            [lambda_t + delta * radial[0] * radial[0], delta * radial[0] * radial[1]],
            [delta * radial[1] * radial[0], lambda_t + delta * radial[1] * radial[1]],
        ]
        for row in range(2):
            for column in range(2):
                matrix[row][column] += weight * tensor[row][column]
    return matrix, skipped


def target_velocity(case: dict[str, Any], matrix: list[list[float]]) -> tuple[tuple[float, float], bool]:
    controlled = case["controlled"]
    position = vec(controlled["position"], "controlled.position")
    goal = vec(controlled["goal"], "controlled.goal")
    if norm(sub(goal, position)) <= float(case["goalTolerance"]):
        return (0.0, 0.0), True
    # g = grad |p-q|^2 = 2(p-q), then solve Gx=g without forming G^-1.
    gradient = scale(sub(position, goal), 2.0)
    determinant = matrix[0][0] * matrix[1][1] - matrix[0][1] * matrix[1][0]
    if not math.isfinite(determinant) or determinant <= 0.0:
        raise AuditError(f"{case['caseId']}: non-positive metric determinant")
    solved = (
        (matrix[1][1] * gradient[0] - matrix[0][1] * gradient[1]) / determinant,
        (-matrix[1][0] * gradient[0] + matrix[0][0] * gradient[1]) / determinant,
    )
    normalization_squared = dot(gradient, solved)
    if not math.isfinite(normalization_squared) or normalization_squared <= 0.0:
        raise AuditError(f"{case['caseId']}: invalid inverse-metric normalization")
    factor = -float(controlled["preferredSpeed"]) / math.sqrt(normalization_squared)
    return scale(solved, factor), False


def eigenvalues_symmetric(matrix: list[list[float]]) -> list[float]:
    trace = matrix[0][0] + matrix[1][1]
    discriminant = math.hypot(matrix[0][0] - matrix[1][1], 2.0 * matrix[0][1])
    return [(trace - discriminant) / 2.0, (trace + discriminant) / 2.0]


def evaluate_case(case: dict[str, Any]) -> dict[str, Any]:
    matrix, skipped = effective_metric(case)
    target, arrived = target_velocity(case, matrix)
    metric_times_velocity = (
        matrix[0][0] * target[0] + matrix[0][1] * target[1],
        matrix[1][0] * target[0] + matrix[1][1] * target[1],
    )
    squared_speed = dot(target, metric_times_velocity)
    return {
        "caseId": case["caseId"],
        "metric": matrix,
        "targetVelocity": list(target),
        "arrived": arrived,
        "coincidentNeighborContributionsSkipped": skipped,
        "eigenvalues": eigenvalues_symmetric(matrix),
        "riemannianSpeed": math.sqrt(max(0.0, squared_speed)),
        "symmetryResidual": abs(matrix[0][1] - matrix[1][0]),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshots", required=True)
    parser.add_argument("--out", required=True)
    arguments = parser.parse_args()
    try:
        values = [evaluate_case(case) for _, case in iter_jsonl(arguments.snapshots)]
        if not values:
            raise AuditError("snapshot fixture is empty")
        write_jsonl(arguments.out, values)
        print(f"independent Riemannian reference wrote {len(values)} cases")
        return 0
    except (AuditError, OSError, ValueError, KeyError, TypeError) as error:
        print(f"independent Riemannian reference failed: {error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
