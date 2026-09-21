"""Package the immutable paper evidence without rewriting historical provenance."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import zipfile
from verify import REFERENCE, REPO, require, sha256, verify_data, verify_hashes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    source, out = args.source.resolve(), args.out.resolve()
    require(not out.exists(), "Use a new, empty packaging destination")
    paper = REPO / "paper"
    verify_hashes(paper)
    verify_data(source, paper)
    original = json.loads((source / "artifact-hashes.json").read_text(encoding="utf-8"))
    for entry in original["files"]:
        path = (source / entry["path"]).resolve()
        require(path.is_relative_to(source), "Unsafe historical inventory path")
        require(path.stat().st_size == entry["bytes"] and sha256(path) == entry["sha256"],
                f"Historical artifact changed: {entry['path']}")
    out.mkdir(parents=True)
    tag = "paper-eumas-2026-v1.0"
    stage = out / tag
    stage.mkdir()
    for name in ["raw-runs.jsonl", "summary.csv", "paper-facing-summary.csv", "artifact-hashes.json",
                 "final-verification.json", "retained-equivalence.json", "concurrency-benchmark.json"]:
        shutil.copyfile(source / name, stage / name)
    shutil.copytree(source / "audit", stage / "audit")
    shutil.copytree(paper, stage / "paper")
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip()
    metadata = {"releaseTag": tag, "scientificReferenceCommit": REFERENCE,
                "publicationCommit": commit, "historicalProvenancePreserved": True,
                "description": "Original evidence plus compact paper bundle; no caches, environments, or publisher proof."}
    (stage / "publication.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    (stage / "ARCHIVED-EVIDENCE").write_text("Immutable published evidence; use a separate output directory for new runs.\n", encoding="utf-8")
    (stage / "README.txt").write_text(
        "Paper evidence: Agent-Induced Riemannian Metric Fields for Crowd Simulation\n"
        "DOI: 10.1007/978-3-032-39395-1_42\n"
        "Open audit/viewer/index.html or audit/viewer-full-rate/index.html locally.\n"
        "Use the repository verifier: python experiments/paper/verify.py --archive-root <this-directory>\n"
        "Historical absolute paths are provenance only. The archive layout and SHA256SUMS locate portable copies.\n"
        "See paper/README.md for table/figure mapping and the repository docs/reproduction.md for new runs.\n",
        encoding="utf-8")
    files = sorted(p for p in stage.rglob("*") if p.is_file())
    forbidden = {"node_modules", "__pycache__", "venv", "jupedsim-venv", ".git", "work"}
    require(not any(forbidden.intersection(p.relative_to(stage).parts) or p.suffix in {".tmp", ".pyc", ".exe"} for p in files), "Unexpected build/temp payload")
    (stage / "SHA256SUMS.txt").write_text("".join(sha256(p) + "  " + p.relative_to(stage).as_posix() + "\n" for p in files), encoding="utf-8")
    verify_hashes(stage)
    archive = out / (tag + "-evidence.zip")
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as target:
        for path in sorted(p for p in stage.rglob("*") if p.is_file()):
            target.write(path, path.relative_to(out).as_posix())
    with zipfile.ZipFile(archive) as check:
        require(check.testzip() is None, "ZIP integrity check failed")
    sidecar = archive.with_suffix(archive.suffix + ".sha256")
    sidecar.write_text(sha256(archive) + "  " + archive.name + "\n", encoding="utf-8")
    print(json.dumps({"archive": str(archive), "bytes": archive.stat().st_size,
                      "sha256": sha256(archive), "files": len(files) + 1}, indent=2))


if __name__ == "__main__":
    main()
