"""Compare production metrics with independently recomputed D0 metrics."""

from __future__ import annotations

import argparse
from typing import Any

from audit_common import AuditError, close, read_json, write_json

ABSOLUTE_TOLERANCE = 1e-9
RELATIVE_TOLERANCE = 1e-9


def comparable_paths(independent: dict[str, Any]) -> list[tuple[str, ...]]:
    paths: list[tuple[str, ...]] = []

    def visit(value: Any, prefix: tuple[str, ...]) -> None:
        if isinstance(value, dict):
            for key in sorted(value):
                if key == "auditMetricsVersion":
                    continue
                visit(value[key], prefix + (key,))
        elif isinstance(value, list):
            for index, entry in enumerate(value):
                visit(entry, prefix + (str(index),))
        else:
            paths.append(prefix)

    visit(independent, ())
    return paths


def lookup(root: Any, path: tuple[str, ...]) -> Any:
    current = root
    for component in path:
        if isinstance(current, list):
            current = current[int(component)]
        elif isinstance(current, dict) and component in current:
            current = current[component]
        else:
            raise AuditError(f"pipeline metric is missing {'.'.join(path)}")
    return current


def compare(pipeline: dict[str, Any], independent: dict[str, Any]) -> dict[str, Any]:
    comparisons: list[dict[str, Any]] = []
    for path in comparable_paths(independent):
        independent_value = lookup(independent, path)
        pipeline_value = lookup(pipeline, path)
        name = ".".join(path)
        if independent_value is None or pipeline_value is None:
            passed = independent_value is None and pipeline_value is None
            absolute_difference = relative_difference = None
        elif isinstance(independent_value, bool) or isinstance(pipeline_value, bool):
            passed = independent_value == pipeline_value
            absolute_difference = relative_difference = None
        elif isinstance(independent_value, (int, float)) and isinstance(pipeline_value, (int, float)):
            absolute_difference = abs(float(pipeline_value) - float(independent_value))
            denominator = max(abs(float(pipeline_value)), abs(float(independent_value)))
            relative_difference = 0.0 if denominator == 0.0 else absolute_difference / denominator
            passed = close(float(pipeline_value), float(independent_value), ABSOLUTE_TOLERANCE, RELATIVE_TOLERANCE)
        else:
            passed = pipeline_value == independent_value
            absolute_difference = relative_difference = None
        comparisons.append({
            "metric": name,
            "pipelineValue": pipeline_value,
            "independentValue": independent_value,
            "absoluteDifference": absolute_difference,
            "relativeDifference": relative_difference,
            "absoluteTolerance": ABSOLUTE_TOLERANCE,
            "relativeTolerance": RELATIVE_TOLERANCE,
            "status": "PASS" if passed else "FAIL",
        })
    failures = [entry for entry in comparisons if entry["status"] == "FAIL"]
    numeric_differences = [entry["absoluteDifference"] for entry in comparisons if entry["absoluteDifference"] is not None]
    return {
        "metricComparisonVersion": 1,
        "status": "PASS" if not failures else "FAIL",
        "metricCount": len(comparisons),
        "failureCount": len(failures),
        "maximumAbsoluteDifference": max(numeric_differences, default=0.0),
        "firstFailure": failures[0] if failures else None,
        "comparisons": comparisons,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pipeline", required=True)
    parser.add_argument("--independent", required=True)
    parser.add_argument("--report", required=True)
    arguments = parser.parse_args()
    try:
        result = compare(read_json(arguments.pipeline), read_json(arguments.independent))
        write_json(arguments.report, result)
        print(f"metric comparison {result['status']}: {result['metricCount']} fields")
        return 0 if result["status"] == "PASS" else 1
    except (AuditError, OSError, ValueError, KeyError, TypeError) as error:
        print(f"metric comparison failed: {error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
