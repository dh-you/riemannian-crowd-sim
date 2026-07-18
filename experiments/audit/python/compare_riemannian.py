"""Fail-closed comparison of independent and production controller snapshots."""

from __future__ import annotations

import argparse
import math
from typing import Any

from audit_common import AuditError, close, iter_jsonl, norm, read_json, sub, vec, write_json

ENTRY_ABSOLUTE = 1e-11
ENTRY_RELATIVE = 1e-11
INVARIANT_TOLERANCE = 1e-10


def compare_values(independent: list[dict[str, Any]], production: list[dict[str, Any]], snapshots: list[dict[str, Any]]) -> dict[str, Any]:
    production_by_id = {entry["caseId"]: entry for entry in production}
    snapshots_by_id = {entry["caseId"]: entry for entry in snapshots}
    cases: list[dict[str, Any]] = []
    maximum_metric_error = 0.0
    maximum_velocity_error = 0.0
    maximum_invariant_error = 0.0
    failures: list[dict[str, Any]] = []
    for reference in independent:
        case_id = reference["caseId"]
        candidate = production_by_id.get(case_id)
        snapshot = snapshots_by_id.get(case_id)
        if candidate is None or snapshot is None:
            failures.append({"caseId": case_id, "check": "presence", "error": "missing production result or snapshot"})
            continue
        metric_errors = [
            abs(float(reference["metric"][row][column]) - float(candidate["metric"][row][column]))
            for row in range(2) for column in range(2)
        ]
        velocity_errors = [
            abs(float(reference["targetVelocity"][axis]) - float(candidate["targetVelocity"][axis]))
            for axis in range(2)
        ]
        maximum_metric_error = max(maximum_metric_error, *metric_errors)
        maximum_velocity_error = max(maximum_velocity_error, *velocity_errors)
        case_failures: list[str] = []
        for row in range(2):
            for column in range(2):
                if not close(float(reference["metric"][row][column]), float(candidate["metric"][row][column]), ENTRY_ABSOLUTE, ENTRY_RELATIVE):
                    case_failures.append(f"metric[{row}][{column}]")
        for axis in range(2):
            if not close(float(reference["targetVelocity"][axis]), float(candidate["targetVelocity"][axis]), ENTRY_ABSOLUTE, ENTRY_RELATIVE):
                case_failures.append(f"targetVelocity[{axis}]")
        for field in ("arrived", "coincidentNeighborContributionsSkipped"):
            if reference[field] != candidate[field]:
                case_failures.append(field)
        symmetry_error = abs(float(candidate["metric"][0][1]) - float(candidate["metric"][1][0]))
        minimum_eigen_error = max(0.0, 1.0 - min(float(value) for value in candidate["eigenvalues"]))
        controlled = snapshot["controlled"]
        speed_error = 0.0 if candidate["arrived"] else abs(float(candidate["riemannianSpeed"]) - float(controlled["preferredSpeed"]))
        invariant_error = max(symmetry_error, minimum_eigen_error, speed_error)
        maximum_invariant_error = max(maximum_invariant_error, invariant_error)
        if invariant_error > INVARIANT_TOLERANCE:
            case_failures.append("invariant")
        if snapshot.get("expectFreeSpace"):
            goal_offset = sub(vec(controlled["goal"], "goal"), vec(controlled["position"], "position"))
            expected = (0.0, 0.0) if norm(goal_offset) == 0.0 else (
                goal_offset[0] / norm(goal_offset) * float(controlled["preferredSpeed"]),
                goal_offset[1] / norm(goal_offset) * float(controlled["preferredSpeed"]),
            )
            if norm(sub(vec(candidate["targetVelocity"], "targetVelocity"), expected)) > INVARIANT_TOLERANCE:
                case_failures.append("free-space direction")
        if snapshot.get("expectSeparatingEqualsFreeSpace"):
            goal_offset = sub(vec(controlled["goal"], "goal"), vec(controlled["position"], "position"))
            expected = (
                goal_offset[0] / norm(goal_offset) * float(controlled["preferredSpeed"]),
                goal_offset[1] / norm(goal_offset) * float(controlled["preferredSpeed"]),
            )
            if norm(sub(vec(candidate["targetVelocity"], "targetVelocity"), expected)) > INVARIANT_TOLERANCE:
                case_failures.append("separating/free-space equality")
        if case_failures:
            failure = {"caseId": case_id, "checks": case_failures, "metricError": max(metric_errors), "velocityError": max(velocity_errors), "invariantError": invariant_error}
            failures.append(failure)
        cases.append({
            "caseId": case_id,
            "status": "FAIL" if case_failures else "PASS",
            "maximumMetricError": max(metric_errors),
            "maximumVelocityError": max(velocity_errors),
            "maximumInvariantError": invariant_error,
        })
    if len(production_by_id) != len(independent) or len(snapshots_by_id) != len(independent):
        failures.append({"check": "case count", "independent": len(independent), "production": len(production_by_id), "snapshots": len(snapshots_by_id)})
    return {
        "riemannianComparisonVersion": 1,
        "status": "PASS" if not failures else "FAIL",
        "caseCount": len(independent),
        "failureCount": len(failures),
        "maximumMetricEntryError": maximum_metric_error,
        "maximumTargetVelocityError": maximum_velocity_error,
        "maximumInvariantError": maximum_invariant_error,
        "firstFailure": failures[0] if failures else None,
        "tolerances": {
            "metricAbsolute": ENTRY_ABSOLUTE,
            "metricRelative": ENTRY_RELATIVE,
            "targetAbsolute": ENTRY_ABSOLUTE,
            "targetRelative": ENTRY_RELATIVE,
            "invariant": INVARIANT_TOLERANCE,
        },
        "cases": cases,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshots", required=True)
    parser.add_argument("--independent", required=True)
    parser.add_argument("--production", required=True)
    parser.add_argument("--report", required=True)
    arguments = parser.parse_args()
    try:
        snapshots = [value for _, value in iter_jsonl(arguments.snapshots)]
        independent = [value for _, value in iter_jsonl(arguments.independent)]
        production = [value for _, value in iter_jsonl(arguments.production)]
        result = compare_values(independent, production, snapshots)
        write_json(arguments.report, result)
        print(f"Riemannian comparison {result['status']}: {result['caseCount']} cases")
        return 0 if result["status"] == "PASS" else 1
    except (AuditError, OSError, ValueError, KeyError, TypeError) as error:
        print(f"Riemannian comparison failed: {error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
