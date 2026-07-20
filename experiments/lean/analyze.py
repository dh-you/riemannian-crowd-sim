#!/usr/bin/env python3
"""Small standard-library summary and independent trajectory checker."""
import csv, json, math, sys
from pathlib import Path
FIELDS = ["row_type", "scenario_type", "metric", "method", "comparator", "n",
          "total_runs", "failures", "median", "q1", "q3", "unit", "difference_definition"]
METRICS = {
    "successFraction": "fraction", "legacyPointGoalSuccessFraction": "fraction",
    "normalizedCompletionTime": "ratio", "pathRatio": "ratio",
    "preCorrectionOverlapExposure": "pair-seconds/agent-second",
    "maximumPhysicalPenetration": "m", "minimumPhysicalClearance": "m",
    "rmsAcceleration": "m/s^2", "correctionRatio": "ratio", "throughput": "arrivals/s",
    "pairwiseAvoidanceOnsetRate": "fraction", "runtimeSeconds": "s",
}
SELECTED = [
    ("pairwise-head_on-lean-seed-0", "conditioned_riemannian_metric_v1"),
    ("pairwise-head_on-lean-seed-0", "euclidean_goal_steering_v1"),
    ("pairwise-crossing-lean-seed-0", "orca_rvo2_v1"),
    ("pairwise-crossing-lean-seed-0", "social_force_pysocialforce_v1"),
    ("circle_antipodal-perturbed-lean-seed-0", "conditioned_riemannian_metric_v1"),
    ("bottleneck-central_opening-lean-seed-0", "orca_rvo2_v1"),
]
TOL = 1e-8; ORCA_TOL = 1e-6  # RVO2 stores float; its runner emits float max_digits10.
def finite(value, path="value"):
    if isinstance(value, float) and not math.isfinite(value): raise ValueError(f"{path} is non-finite")
    if isinstance(value, list):
        for index, entry in enumerate(value): finite(entry, f"{path}[{index}]")
    elif isinstance(value, dict):
        for key, entry in value.items(): finite(entry, f"{path}.{key}")
def lines(path):
    with path.open(encoding="utf-8") as source:
        for number, line in enumerate(source, 1):
            if line.strip():
                value = json.loads(line); finite(value, f"{path}:{number}"); yield value

def quantile(values, fraction):
    ordered = sorted(values)
    if not ordered: return None
    position = (len(ordered) - 1) * fraction; lower = int(math.floor(position)); upper = int(math.ceil(position))
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)

def method_name(record): return record.get("ablation") or record["method"]
def scenario_name(record):
    name = record["scenarioType"]
    return name.split("-measured-")[0] if record["phase"] == "runtime" else name
def usable_records(records):
    phases = {row["phase"] for row in records}
    selected = {"test", "ablation", "runtime"} if "test" in phases else {"audit"}
    return [row for row in records if row["phase"] in selected and not row.get("warmup", False)]

def summarize(raw_path, output_path):
    records = list(lines(raw_path)); keys = [row["key"] for row in records]
    if len(keys) != len(set(keys)): raise ValueError("raw-runs.jsonl has duplicate keys")
    records = usable_records(records); rows = []
    groups = {}
    for record in records:
        metric_names = ["runtimeSeconds"] if record["phase"] == "runtime" else list(METRICS)[:-1]
        for metric in metric_names:
            groups.setdefault((scenario_name(record), metric, method_name(record)), []).append(record)
    for (scenario, metric, method), group in sorted(groups.items()):
        values = [row[metric] for row in group if row["status"] == "PASS" and row.get(metric) is not None]
        rows.append(row("estimate", scenario, metric, method, "", values, len(group),
                        sum(item["status"] == "FAIL" for item in group), ""))
    pair_groups = {}
    for record in records:
        identity = (record["phase"], scenario_name(record), record["seed"], record.get("repetition"))
        pair_groups.setdefault(identity, {})[method_name(record)] = record
    for (phase, scenario, _seed, _rep), group in sorted(pair_groups.items()):
        reference = "full" if phase == "ablation" else "riemannian"
        if reference not in group: continue
        for comparator in sorted(name for name in group if name != reference):
            metric_names = ["runtimeSeconds"] if phase == "runtime" else list(METRICS)[:-1]
            for metric in metric_names:
                left, right = group[reference], group[comparator]
                value = None if left["status"] != "PASS" or right["status"] != "PASS" else difference(left.get(metric), right.get(metric))
                pair_groups.setdefault(("values", scenario, metric, reference, comparator), []).append(value)
    for key, values in sorted((key, value) for key, value in pair_groups.items() if key[0] == "values"):
        _, scenario, metric, reference, comparator = key; valid = [value for value in values if value is not None]
        rows.append(row("paired_difference", scenario, metric, reference, comparator, valid,
                        len(values), len(values) - len(valid), f"{reference} minus {comparator}"))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", newline="", encoding="utf-8") as target:
        writer = csv.DictWriter(target, fieldnames=FIELDS); writer.writeheader(); writer.writerows(rows)
    return len(records), len(rows)

def difference(left, right):
    return None if left is None or right is None else left - right
def row(kind, scenario, metric, method, comparator, values, total, failures, definition):
    return {"row_type": kind, "scenario_type": scenario, "metric": metric, "method": method,
            "comparator": comparator, "n": len(values), "total_runs": total, "failures": failures,
            "median": quantile(values, .5), "q1": quantile(values, .25), "q3": quantile(values, .75),
            "unit": METRICS[metric], "difference_definition": definition}

def close(actual, expected, label, tolerance=TOL):
    if actual is None or expected is None:
        if actual is not expected: raise ValueError(f"{label}: null mismatch {actual} != {expected}")
    elif not math.isclose(actual, expected, rel_tol=tolerance, abs_tol=tolerance):
        raise ValueError(f"{label}: {actual} != {expected}")

def segment_disk_fraction(start, end, center, radius):
    sx, sy = start[0] - center[0], start[1] - center[1]
    coordinate_scale = max([1.0, radius] + [abs(value) for value in start + center])
    if math.hypot(sx, sy) <= radius + 2e-7 * coordinate_scale: return 0.0
    dx, dy = end[0] - start[0], end[1] - start[1]
    a = dx * dx + dy * dy
    if a <= 0.0: return None
    b = 2.0 * (sx * dx + sy * dy); c = sx * sx + sy * sy - radius * radius
    discriminant = b * b - 4.0 * a * c
    scale = max(1.0, abs(b * b), abs(4.0 * a * c))
    if discriminant >= -1e-12 * scale:
        root = math.sqrt(max(0.0, discriminant))
        candidates = [max(0.0, min(1.0, value)) for value in
                      [(-b - root) / (2.0 * a), (-b + root) / (2.0 * a)]
                      if -1e-12 <= value <= 1.0 + 1e-12]
        if candidates: return min(candidates)
    coordinate_scale = max([1.0, radius] + [abs(value) for value in end + center])
    return 1.0 if math.dist(end, center) <= radius + 2e-7 * coordinate_scale else None

def completion_rule(scenario, agent_id):
    completion = scenario.get("completion")
    if completion is None: return {"type": "goal_disk"}
    rule = completion["rule"]
    if rule["type"] != "per_agent_directional_line": return rule
    entry = next(entry for entry in rule["rules"] if entry["agentId"] == agent_id)
    return {"type": "directional_line", **entry}

def completion_fraction(scenario, definition, start, end):
    rule = completion_rule(scenario, definition["id"])
    if rule["type"] == "goal_disk":
        return segment_disk_fraction(start, end, definition["goal"], scenario["simulation"]["goalTolerance"])
    axis = 0 if rule["axis"] == "x" else 1
    before, after, threshold = start[axis], end[axis], rule["threshold"]
    crosses = before < threshold < after if rule["direction"] == "positive" else before > threshold > after
    return (threshold - before) / (after - before) if crosses else None

def verify_run(run_dir):
    manifest = json.loads((run_dir / "audit-manifest.json").read_text(encoding="utf-8")); tolerance = ORCA_TOL if manifest["methodId"] == "orca_rvo2_v1" else TOL
    audit_root = next(parent for parent in run_dir.parents if parent.name == "audit")
    manifest_scenario = Path(manifest["scenarioPath"])
    local_scenario = run_dir / "scenario.json"
    scenario_path = (manifest_scenario if manifest_scenario.exists() else local_scenario
                     if local_scenario.exists() else audit_root / "visuals" / "scenarios" / f"{manifest['scenarioName']}.json")
    scenario = json.loads(scenario_path.read_text(encoding="utf-8")); metrics = json.loads((run_dir / "run-metrics.json").read_text(encoding="utf-8"))
    full = run_dir / "engine-steps-full.jsonl"; trajectory = full if full.exists() else run_dir / "engine-steps.jsonl"
    steps = list(lines(trajectory)); agents = sorted(scenario["agents"], key=lambda item: item["id"])
    ids = [agent["id"] for agent in agents]; definitions = {agent["id"]: agent for agent in agents}
    previous = {agent["id"]: agent["position"] for agent in agents}
    previous_velocity = {agent["id"]: agent["velocity"] for agent in agents}
    completed = {agent["id"] for agent in agents if completion_rule(scenario, agent["id"])["type"] == "goal_disk"
                 and completion_fraction(scenario, agent, agent["position"], agent["position"]) is not None}
    legacy_arrived = set(); final_arrived = set(); lengths = {agent_id: 0.0 for agent_id in ids}
    minimum = None; maximum = 0.0; correction = 0.0; pre_overlap_pair_seconds = 0.0
    acceleration_squared_sum = 0.0; acceleration_sample_count = 0
    dt = scenario["simulation"]["dt"]
    expected_steps = round(scenario["simulation"]["horizonSeconds"] / scenario["simulation"]["dt"])
    if len(steps) != expected_steps: raise ValueError(f"{run_dir}: missing steps {len(steps)} != {expected_steps}")
    for index, step in enumerate(steps):
        if step["stepIndex"] != index: raise ValueError(f"{run_dir}: discontinuous step index")
        ordered = step["agents"]
        if [agent["id"] for agent in ordered] != ids: raise ValueError(f"{run_dir}: duplicate, missing, or unordered agent ID")
        pre_overlap_pair_seconds += step["diagnostics"]["preCorrectionOverlapPairs"] * dt
        for agent in ordered:
            agent_id = agent["id"]
            for actual, expected in zip(agent["positionBefore"], previous[agent_id]): close(actual, expected, "position continuity", tolerance)
            if agent_id not in legacy_arrived:
                lengths[agent_id] += math.dist(agent["positionBefore"], agent["postCorrectionPosition"])
                if segment_disk_fraction(agent["positionBefore"], agent["postCorrectionPosition"],
                                         definitions[agent_id]["goal"], scenario["simulation"]["goalTolerance"]) is not None:
                    legacy_arrived.add(agent_id)
            if agent_id not in completed:
                acceleration = [(agent["realizedVelocity"][axis] - previous_velocity[agent_id][axis]) / dt
                                for axis in range(2)]
                acceleration_squared_sum += sum(value * value for value in acceleration)
                acceleration_sample_count += 1
                if completion_fraction(scenario, definitions[agent_id], agent["positionBefore"],
                                       agent["postCorrectionPosition"]) is not None:
                    completed.add(agent_id)
            if agent["arrived"]: final_arrived.add(agent_id)
            else: final_arrived.discard(agent_id)
            previous[agent_id] = agent["postCorrectionPosition"]
            previous_velocity[agent_id] = agent["realizedVelocity"]
        for first in range(len(ordered)):
            for second in range(first + 1, len(ordered)):
                a, b = ordered[first], ordered[second]
                clearance = math.dist(a["preCorrectionPosition"], b["preCorrectionPosition"]) - definitions[a["id"]]["radius"] - definitions[b["id"]]["radius"]
                minimum = clearance if minimum is None else min(minimum, clearance); maximum = max(maximum, -clearance)
        correction += step["diagnostics"]["totalCorrectionDisplacement"]
    simulated_duration = steps[-1]["time"] if steps else 0.0
    exposure_denominator = len(ids) * simulated_duration
    overlap_exposure = None if exposure_denominator == 0 else pre_overlap_pair_seconds / exposure_denominator
    rms_acceleration = None if acceleration_sample_count == 0 else math.sqrt(
        acceleration_squared_sum / acceleration_sample_count)
    close(len(completed) / len(ids), metrics["completion"]["successFraction"], "completion", tolerance)
    close(len(legacy_arrived) / len(ids), metrics["completion"]["legacyPointGoalSuccessFraction"], "legacy completion", tolerance)
    close(len(final_arrived) / len(ids), metrics["completion"]["legacyFinalPointGoalArrivedFraction"], "final arrived", tolerance)
    close(minimum, metrics["separation"]["minimumPreCorrectionAgentClearance"], "minimum clearance", tolerance)
    close(maximum, metrics["separation"]["maximumPreCorrectionAgentPenetration"], "maximum penetration", tolerance)
    close(overlap_exposure, metrics["separation"]["preCorrectionOverlapPairSecondsPerAgentSecond"],
          "pre-correction overlap exposure", tolerance)
    close(rms_acceleration, metrics["smoothness"]["rmsAcceleration"], "rms acceleration", tolerance)
    close(acceleration_sample_count, metrics["smoothness"]["accelerationSampleCount"],
          "acceleration sample count", tolerance)
    expected_length = sum(entry["pathEfficiency"] * math.dist(definitions[entry["id"]]["position"], definitions[entry["id"]]["goal"])
                          for entry in metrics["completion"]["perAgent"] if entry["pathEfficiency"] is not None)
    close(sum(lengths[agent_id] for agent_id in legacy_arrived), expected_length, "arrived path length", tolerance)
    close(correction, metrics["correctionDependence"]["totalCorrectionDisplacement"], "correction displacement", tolerance)
    return manifest["scenarioName"], manifest["methodId"]

def verify_selected(audit_root):
    found = {}
    for trajectory in (audit_root / "visuals" / "runs").glob("**/engine-steps.jsonl"):
        directory = trajectory.parent; manifest = json.loads((directory / "audit-manifest.json").read_text(encoding="utf-8"))
        found[(manifest["scenarioName"], manifest["methodId"])] = directory
    missing = [item for item in SELECTED if item not in found]
    if missing: raise ValueError(f"missing selected audit trajectories: {missing}")
    return [verify_run(found[item]) for item in SELECTED]

def verify_all(audit_root):
    directories = sorted({path.parent for path in (audit_root / "visuals" / "runs").glob("**/engine-steps.jsonl")})
    if not directories: raise ValueError(f"no audit trajectories found under {audit_root}")
    return [verify_run(directory) for directory in directories]

def main():
    if len(sys.argv) == 3 and sys.argv[1] == "--verify-run":
        print(f"verified {verify_run(Path(sys.argv[2]).resolve())}"); return
    if len(sys.argv) == 4 and sys.argv[1] == "--summarize":
        count, rows = summarize(Path(sys.argv[2]).resolve(), Path(sys.argv[3]).resolve())
        print(f"lean summary: {count} source runs, {rows} summary rows"); return
    study_path = Path("experiments/lean/study.json")
    verify = verify_selected
    if len(sys.argv) == 3 and sys.argv[1] == "--study":
        study_path = Path(sys.argv[2]); verify = verify_all
    elif len(sys.argv) != 1:
        raise ValueError("usage: analyze.py [--study PATH] | --verify-run DIR | --summarize RAW OUTPUT")
    study = json.loads(study_path.read_text(encoding="utf-8")); outputs = study["outputs"]
    count, rows = summarize(Path(outputs["raw"]), Path(outputs["summary"])); checked = verify(Path(outputs["auditRoot"]))
    print(f"lean analysis: {count} source runs, {rows} summary rows, {len(checked)} trajectories verified at {TOL} (ORCA float boundary {ORCA_TOL})")

if __name__ == "__main__":
    try: main()
    except Exception as error:
        print(f"lean analysis failed: {error}", file=sys.stderr); sys.exit(1)
