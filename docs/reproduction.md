# Reproducing the paper

## Environment

Full native reproduction is supported by the pinned Windows x64 environment:
Node.js >=22.12, CPython 3.12, Git, MinGW-w64 G++, CMake, and Ninja on PATH.
The original build used Python 3.12.10, G++ 15.2.0, and CMake 4.1.2; its complete
build manifest is in `paper/provenance/`. Use `npm.cmd` instead of `npm` in
PowerShell if script execution policy blocks npm.ps1.

`npm ci` installs locked JavaScript dependencies. `baselines:bootstrap` clones
only pinned RVO2 and creates a local JuPedSim environment. Its Windows CPython
3.12 wheel and every dependency are hash-locked. No global Python packages are
modified. Other native platforms are not claimed as validated.

```sh
npm ci
npm test
npm run build
npm run baselines:bootstrap
npm run baselines:build
npm run baselines:verify
npm run test:baselines
```

## Evidence versus new runs

`paper/` contains small, tracked, immutable copies of the published evidence.
The release ZIP contains the full recorded evidence and viewers; it is marked
`ARCHIVED-EVIDENCE`. Download it and its `.sha256` sidecar from the
[release](https://github.com/dh-you/riemannian-crowd-sim/releases/tag/paper-eumas-2026-v1.0).
On Windows, compare `Get-FileHash <archive.zip> -Algorithm SHA256` with the sidecar,
then use `Expand-Archive <archive.zip> <destination>`.

Run `python experiments/paper/verify.py --archive-root <destination>/paper-eumas-2026-v1.0`
to verify the extracted archive. Open `audit/viewer/index.html` inside that folder
for sampled trajectories, or `audit/viewer-full-rate/index.html` for full-rate
trajectories. Both viewers embed their data and work locally without a server.
The archive preserves original absolute provenance paths; the portable file
layout and checksum inventory locate the distributed copies.

The historical experiment commit is `05241d55a90a7b873d0a403a30682e8577f8111d`.
The release tag names the cleanup commit, not a replacement experiment commit.
The reference tag `paper-eumas-2026-scientific-reference` preserves the original.

## Run the frozen study independently

`experiments/lean/study.json` retains the exact original study definition.
The CLI relocates only output paths and approval; it does not modify scientific
parameters or assignment identities. All commands below must use the same
`--out`. Omit it to use `results/reproduction`.

```sh
npm run paper:audit -- --out results/reproduction
```

The audit performs a concurrency benchmark, then generates 28 runs: 20 visual
trajectories (four methods by five scenarios) and eight diagnostics. Open
`results/reproduction/audit/viewer/index.html`. A human must inspect all 20
trajectories, including wall behavior, crossings, completion, and pre-correction
versus realized motion. Only after review, create
`results/reproduction/audit/review-approved.txt` with reviewer name, date, and
the reviewed run set. Do not copy approval from the published archive.

```sh
npm run paper:test -- --out results/reproduction --jobs 4
npm run paper:ablation -- --out results/reproduction --jobs 4
npm run paper:runtime -- --out results/reproduction --jobs 1
npm run paper:analyze -- --out results/reproduction
```

The corresponding `npm run lean -- --phase <phase> ...` commands remain valid.
`--resume` reuses matching successful assignments in the selected directory.
Use a new output directory after changing the implementation or environment;
do not combine implementation versions in one study.

Expected counts are 28 audit + 280 headline + 60 ablation + 48 runtime = **416**.
Runtime includes 12 warmups and 36 measured repetitions. Analysis excludes
warmups, summarizes 376 test/ablation/runtime records, and produces 637 summary
rows and 100 Table 1 source rows. Runtime values depend on the machine, compiler,
and load; do not expect the original timings from a different environment.

`paper:analyze` independently checks selected full trajectories, then writes
`summary.csv` and `paper-facing-summary.csv`. `paper:verify` checks the published
bundle without running simulations. The historical `lean:equivalence` and
`lean:verify` tools remain available for their additional evidence-packaging
workflow and also accept `--out`; their requirements include a retained
equivalence report and both viewer variants, beyond the ordinary study run.

## Scientific interpretation

See [experiment-protocol.md](experiment-protocol.md) for the completion and
metric definitions and [scientific-core.md](scientific-core.md) for equations.
Completion time is conditional on completed agents. Raw safety precedes
projection; native baselines have no shared projection. Smoothness uses the
common 1/60-second output rate. JuPedSim performs two 1/120-second substeps per
shared step, both counted in runtime. No human-trajectory calibration or
universal collision-free guarantee is claimed.

## Verify cleanup equivalence

Run `npm run paper:regression -- --canonical <extracted-evidence-root> --out results/publication-regression`
to compare all 20 seed-0 audit trajectories and scalar scientific metrics against
the published reference (1e-8 tolerance; ORCA 1e-6). Runtime is excluded.
The report records the cleanup implementation commit separately. This numerical
comparison does not substitute for human review of a new study.
