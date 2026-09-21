"""Verify published evidence without native engines or third-party Python packages."""
import argparse
import csv
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import tempfile
from collections import Counter

REPO = Path(__file__).resolve().parents[2]
REFERENCE = "05241d55a90a7b873d0a403a30682e8577f8111d"


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def verify_hashes(root):
    count = 0
    for line in (root / "SHA256SUMS.txt").read_text(encoding="utf-8").splitlines():
        expected, name = line.split("  ", 1)
        path = (root / name).resolve()
        require(path.is_relative_to(root.resolve()), f"Unsafe inventory path: {name}")
        require(path.is_file() and sha256(path) == expected, f"Checksum mismatch: {name}")
        count += 1
    require(count > 0, "Empty checksum inventory")
    return count


def verify_data(root, paper):
    spec = importlib.util.spec_from_file_location("paper_analysis", REPO / "experiments/lean/analyze.py")
    analysis = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(analysis)
    raw = root / "raw-runs.jsonl"
    records = list(analysis.lines(raw))
    require(len({r["key"] for r in records}) == len(records), "Duplicate run identities")
    require(Counter(r["phase"] for r in records) == {"audit": 28, "test": 280, "ablation": 60, "runtime": 48}, "Study counts differ")
    require(all(r["status"] == "PASS" for r in records), "Failed run in published evidence")
    require(all(r["implementationCommit"] == REFERENCE for r in records), "Historical implementation identity differs")
    require(Counter(r["method"] for r in records if r["phase"] == "test") ==
            {"riemannian": 70, "goal": 70, "orca": 70, "jupedsim-sfm": 70}, "Headline method counts differ")
    require(sum(r["phase"] == "runtime" and bool(r.get("warmup")) for r in records) == 12, "Warmup count differs")
    frozen = json.loads((paper / "study.json").read_text(encoding="utf-8"))
    active = json.loads((REPO / "experiments/lean/study.json").read_text(encoding="utf-8"))
    require(frozen == active, "Active study differs from frozen paper configuration")
    for r in records:
        if r["phase"] != "ablation":
            require(r["assignmentIdentity"]["methodConfig"] == frozen["methods"][r["method"]], f"Method changed: {r['key']}")
    with tempfile.TemporaryDirectory(prefix="paper-summary-") as directory:
        temp = Path(directory)
        require(analysis.summarize(raw, temp / "summary.csv") == (376, 637), "Summary dimensions differ")
        require(analysis.paper_summary(raw, temp / "paper-facing-summary.csv") == (280, 100), "Table dimensions differ")
        for name in ["summary.csv", "paper-facing-summary.csv"]:
            require(read_csv(root / name) == read_csv(temp / name), f"Recomputed {name} differs")
    rows = {(r["scenario_type"], r["method"], r["metric"]): r for r in read_csv(root / "paper-facing-summary.csv")}
    metrics = ["successFraction", "normalizedCompletionTime", "preCorrectionOverlapExposure", "maximumPhysicalPenetration", "rmsAcceleration"]
    # Displayed Table 1 values, transcribed from the author proof; no PDF distributed.
    expected = json.loads((paper / "table-1.json").read_text(encoding="utf-8"))
    for entry in expected:
        for metric, displayed in zip(metrics, entry["values"]):
            row = rows[entry["scenario"], entry["method"], metric]
            value = float(row["median"])
            require(int(row["total_runs"]) == (20 if entry["scenario"] in ("head-on", "crossing") else 10), "Run count differs")
            available = [r for r in records if r["phase"] == "test" and r["scenarioType"] == entry["scenario"]
                         and r["method"] == entry["method"] and r.get(metric) is not None]
            require(int(row["n"]) == len(available), "Conditional sample size differs")
            if displayed.startswith("<"):
                require(0 <= value < float(displayed[1:]), f"Table threshold differs: {entry} {metric}")
            else:
                places = len(displayed.split(".")[1])
                require(abs(value - float(displayed)) <= 0.5 * 10 ** -places + 1e-12, f"Table rounding differs: {entry} {metric}")
    summary = {(r["scenario_type"], r["method"], r["metric"]): r for r in read_csv(root / "summary.csv") if r["row_type"] == "estimate"}
    claims = [
        ("corridor", "full", "successFraction", .925, 3),
        ("corridor", "isotropic", "successFraction", .667, 3),
        ("corridor", "no-closing", "successFraction", .033, 3),
        ("corridor", "no-closing", "preCorrectionOverlapExposure", .116, 3),
        ("corridor", "no-visibility", "successFraction", .675, 3),
        ("corridor", "full", "rmsAcceleration", 2.48, 2),
        ("corridor", "no-visibility", "rmsAcceleration", 2.91, 2),
        ("circle-n50", "riemannian", "runtimeSeconds", 2.33, 2),
        ("circle-n50", "orca", "runtimeSeconds", 2.90, 2),
        ("circle-n200", "riemannian", "runtimeSeconds", 20.52, 2),
        ("circle-n200", "orca", "runtimeSeconds", 17.79, 2),
        ("circle-n50", "jupedsim-sfm", "runtimeSeconds", 12.53, 2),
        ("circle-n200", "jupedsim-sfm", "runtimeSeconds", 55.98, 2),
    ]
    for scenario, method, metric, value, places in claims:
        actual = float(summary[scenario, method, metric]["median"])
        require(math.isclose(actual, value, abs_tol=.5 * 10 ** -places + 1e-12), f"Paper claim differs: {scenario}/{method}/{metric}")
    return {"runs": len(records), "tableCells": len(expected) * len(metrics), "summaryRows": 637}


def read_csv(path):
    with path.open(newline="", encoding="utf-8") as source:
        return list(csv.DictReader(source))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive-root", type=Path)
    args = parser.parse_args()
    paper = REPO / "paper"
    checked = verify_hashes(paper)
    report = verify_data(paper / "data", paper)
    if args.archive_root:
        root = args.archive_root.resolve()
        checked += verify_hashes(root)
        verify_data(root, paper)
        require((root / "ARCHIVED-EVIDENCE").is_file(), "Archive protection marker missing")
        manifests = list((root / "audit/visuals/runs").glob("**/audit-manifest.json"))
        require(len(manifests) == 20, "Expected 20 visual run manifests")
        for manifest_path in manifests:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            require(manifest["implementationCommit"] == REFERENCE, "Audit implementation differs")
            scenario = root / "audit/visuals/scenarios" / (manifest["scenarioName"] + ".json")
            require(sha256(scenario) == manifest["scenarioSha256"], "Scenario hash differs")
            full = manifest_path.parent / "engine-steps-full.jsonl"
            with full.open(encoding="utf-8") as source:
                count = sum(1 for line in source if line.strip())
            require(count == manifest["expectedStepCount"] == manifest["actualStepCount"], "Full trajectory count differs")
        for viewer in ["viewer", "viewer-full-rate"]:
            for name in ["index.html", "review-data.js", "viewer.js", "viewer.css"]:
                require((root / "audit" / viewer / name).is_file(), f"Missing {viewer}/{name}")
    print(json.dumps({"status": "PASS", "checksummedFiles": checked, **report}, indent=2))


if __name__ == "__main__":
    main()
