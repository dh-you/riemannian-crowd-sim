"""Render a deterministic, dependency-free SVG trajectory audit sheet."""

from __future__ import annotations

import argparse
import html
from pathlib import Path
from typing import Any

from audit_common import AuditError, deflection_degrees, distance, iter_jsonl, load_scenario, sub, vec

COLORS = ("#0072B2", "#D55E00", "#009E73", "#CC79A7", "#E69F00", "#56B4E9", "#000000", "#999999")


def render(scenario: dict[str, Any], records: list[dict[str, Any]], method_name: str) -> str:
    definitions = {int(agent["id"]): agent for agent in scenario["agents"]}
    points: list[tuple[float, float]] = []
    paths: dict[int, list[tuple[float, float]]] = {}
    for agent_id, definition in definitions.items():
        start = vec(definition["position"], "position")
        goal = vec(definition["goal"], "goal")
        paths[agent_id] = [start]
        points.extend((start, goal))
    for wall in scenario["walls"]:
        points.extend((vec(wall["start"], "wall.start"), vec(wall["end"], "wall.end")))
    for record in records:
        for agent in record["agents"]:
            agent_id = int(agent["id"])
            pre = vec(agent["preCorrectionPosition"], "pre")
            post = vec(agent["postCorrectionPosition"], "post")
            paths[agent_id].append(post)
            points.extend((pre, post))
    if not points:
        raise AuditError("cannot render an empty audit sheet")
    margin = max(0.5, max(float(agent["radius"]) for agent in scenario["agents"]) * 2.0)
    minimum_x = min(point[0] for point in points) - margin
    maximum_x = max(point[0] for point in points) + margin
    minimum_y = min(point[1] for point in points) - margin
    maximum_y = max(point[1] for point in points) + margin
    width, height, legend_height = 900.0, 600.0, 94.0
    scale_factor = min((width - 40.0) / max(maximum_x - minimum_x, 1e-9), (height - legend_height - 40.0) / max(maximum_y - minimum_y, 1e-9))

    def screen(point: tuple[float, float]) -> tuple[float, float]:
        return (
            20.0 + (point[0] - minimum_x) * scale_factor,
            20.0 + (maximum_y - point[1]) * scale_factor,
        )

    minimum_clearance: float | None = None
    minimum_record: dict[str, Any] | None = None
    minimum_pair: tuple[dict[str, Any], dict[str, Any]] | None = None
    for record in records:
        agents = record["agents"]
        for first_index, first in enumerate(agents):
            for second in agents[first_index + 1 :]:
                clearance = (
                    distance(vec(first["preCorrectionPosition"], "pre"), vec(second["preCorrectionPosition"], "pre"))
                    - float(definitions[int(first["id"])]["radius"])
                    - float(definitions[int(second["id"])]["radius"])
                )
                if minimum_clearance is None or clearance < minimum_clearance:
                    minimum_clearance, minimum_record, minimum_pair = clearance, record, (first, second)

    onset_markers: list[tuple[int, tuple[float, float]]] = []
    seen_onset: set[int] = set()
    for record in records:
        for agent in record["agents"]:
            agent_id = int(agent["id"])
            if agent_id in seen_onset:
                continue
            before = vec(agent["positionBefore"], "positionBefore")
            goal_offset = sub(vec(definitions[agent_id]["goal"], "goal"), before)
            angle = deflection_degrees(vec(agent["commandVelocity"], "commandVelocity"), goal_offset)
            if angle is not None and angle > 5.0:
                onset_markers.append((agent_id, before))
                seen_onset.add(agent_id)

    elements = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600" viewBox="0 0 900 600">',
        '<rect width="900" height="600" fill="white"/>',
        '<g font-family="Arial, sans-serif">',
    ]
    for wall in scenario["walls"]:
        start = screen(vec(wall["start"], "wall.start"))
        end = screen(vec(wall["end"], "wall.end"))
        thickness = max(1.0, float(wall["thickness"]) * scale_factor)
        elements.append(f'<line x1="{start[0]:.3f}" y1="{start[1]:.3f}" x2="{end[0]:.3f}" y2="{end[1]:.3f}" stroke="#555" stroke-width="{thickness:.3f}" stroke-linecap="round"/>')
    for order, agent_id in enumerate(sorted(definitions)):
        color = COLORS[order % len(COLORS)]
        path_data = " ".join(f"{point[0]:.3f},{point[1]:.3f}" for point in map(screen, paths[agent_id]))
        elements.append(f'<polyline points="{path_data}" fill="none" stroke="{color}" stroke-width="2" stroke-dasharray="{4 + order % 3},{2 + order % 2}"/>')
        start = screen(vec(definitions[agent_id]["position"], "position"))
        goal = screen(vec(definitions[agent_id]["goal"], "goal"))
        elements.append(f'<circle cx="{start[0]:.3f}" cy="{start[1]:.3f}" r="5" fill="{color}" stroke="#111"/>')
        elements.append(f'<path d="M {goal[0]-6:.3f} {goal[1]:.3f} L {goal[0]+6:.3f} {goal[1]:.3f} M {goal[0]:.3f} {goal[1]-6:.3f} L {goal[0]:.3f} {goal[1]+6:.3f}" stroke="{color}" stroke-width="2"/>')
    if minimum_record is not None and minimum_pair is not None:
        for agent in minimum_pair:
            agent_id = int(agent["id"])
            radius = float(definitions[agent_id]["radius"]) * scale_factor
            pre = screen(vec(agent["preCorrectionPosition"], "pre"))
            post = screen(vec(agent["postCorrectionPosition"], "post"))
            elements.append(f'<circle cx="{pre[0]:.3f}" cy="{pre[1]:.3f}" r="{radius:.3f}" fill="none" stroke="#B00020" stroke-width="2"/>')
            elements.append(f'<circle cx="{post[0]:.3f}" cy="{post[1]:.3f}" r="{radius:.3f}" fill="none" stroke="#006400" stroke-width="2" stroke-dasharray="4,3"/>')
    for agent_id, position in onset_markers:
        point = screen(position)
        elements.append(f'<polygon points="{point[0]:.3f},{point[1]-7:.3f} {point[0]-6:.3f},{point[1]+5:.3f} {point[0]+6:.3f},{point[1]+5:.3f}" fill="none" stroke="#6A0DAD" stroke-width="2"/>')
    legend_y = height - legend_height + 20.0
    escaped_name = html.escape(str(scenario.get("name", "unknown")))
    escaped_method = html.escape(method_name)
    clearance_text = "n/a" if minimum_clearance is None else f"{minimum_clearance:.6g} m"
    elements.extend([
        f'<text x="20" y="{legend_y:.3f}" font-size="16" font-weight="bold">Stage D0 trajectory audit</text>',
        f'<text x="20" y="{legend_y + 22:.3f}" font-size="13">Scenario: {escaped_name} | Method: {escaped_method}</text>',
        f'<text x="20" y="{legend_y + 42:.3f}" font-size="13">Minimum pre-correction agent clearance: {clearance_text}</text>',
        f'<text x="20" y="{legend_y + 62:.3f}" font-size="12">solid red circles: closest pre-correction encounter; dashed green: post-correction; purple triangles: avoidance onset</text>',
        '</g>',
        '</svg>',
    ])
    return "\n".join(elements) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scenario", required=True)
    parser.add_argument("--trajectory", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--method", default="unspecified")
    arguments = parser.parse_args()
    try:
        scenario = load_scenario(arguments.scenario)
        records = [value for _, value in iter_jsonl(arguments.trajectory)]
        output = Path(arguments.out)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(render(scenario, records, arguments.method), encoding="utf-8", newline="\n")
        print(f"visual audit wrote {output}")
        return 0
    except (AuditError, OSError, ValueError, KeyError, TypeError) as error:
        print(f"visual audit failed: {error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
