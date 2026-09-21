# Published paper evidence

All historical evidence retains its original bytes and provenance. The experiment commit is
`05241d55a90a7b873d0a403a30682e8577f8111d`; the publication cleanup has a separate release commit.

| Paper item | Source |
|---|---|
| Table 1 | `data/paper-facing-summary.csv`; display values in `table-1.json` |
| Figure 1 | `figures/figure-1.pdf` / `.png`; release `audit/visuals/` seed-0 scenarios and pre-correction trajectories |
| Figure 2 left | `data/summary.csv`, corridor ablations: full, isotropic, no-closing, no-visibility |
| Figure 2 right | `data/summary.csv`, circle-n50/100/200, runtimeSeconds, three measured repetitions |

Figure provenance records exact source and output hashes. Both source figures were visually
compared with Figures 1–2 in the author proof. No publisher proof is distributed.

## Table 1

Medians across 20 runs per pairwise setting and 10 per dense setting. Completion time
is conditional on completion. Overlap is pair-seconds per agent-second; penetration is metres.

The JuPedSim corridor completion-time median uses nine non-null runs out of ten;
one run has no completed agents. The CSV preserves this conditional sample size.

| Scenario | Method | Completion | T/T0 | Raw overlap | Raw penetration | RMS acc. |
|---|---|---:|---:|---:|---:|---:|
| head-on | Ours | 1.000 | 1.05 | .000 | .000 | 2.48 |
| head-on | Goal+Proj. | 1.000 | 1.05 | .008 | .034 | 3.99 |
| head-on | ORCA | 1.000 | 1.00 | .000 | .000 | 2.41 |
| head-on | JuPedSim SFM | 1.000 | 1.17 | <.001 | .001 | 2.34 |
| crossing | Ours | 1.000 | 1.07 | .000 | .000 | 2.40 |
| crossing | Goal+Proj. | 1.000 | 1.02 | .008 | .022 | 3.32 |
| crossing | ORCA | 1.000 | 1.01 | .000 | .000 | 2.46 |
| crossing | JuPedSim SFM | 1.000 | 1.07 | .000 | .000 | 1.35 |
| circle | Ours | 1.000 | 1.84 | .410 | .062 | 2.79 |
| circle | Goal+Proj. | 1.000 | 1.96 | .530 | .081 | 3.37 |
| circle | ORCA | 1.000 | 1.59 | .025 | .006 | 2.52 |
| circle | JuPedSim SFM | .960 | 2.58 | <.001 | .034 | 2.04 |
| corridor | Ours | .842 | 1.52 | .485 | .082 | 2.52 |
| corridor | Goal+Proj. | .996 | 1.27 | .599 | .100 | 4.02 |
| corridor | ORCA | .608 | 1.41 | .145 | .019 | .84 |
| corridor | JuPedSim SFM | .471 | 1.62 | <.001 | .018 | 1.97 |
| bottleneck | Ours | 1.000 | 1.52 | .922 | .091 | 3.49 |
| bottleneck | Goal+Proj. | 1.000 | 1.17 | 1.080 | .114 | 4.42 |
| bottleneck | ORCA | .732 | 1.46 | .253 | .004 | .86 |
| bottleneck | JuPedSim SFM | .862 | 1.36 | <.001 | .022 | 2.38 |

## Verification and full evidence

Run `npm run paper:verify` to check checksums, all 416 run identities and counts,
recomputed summaries, 100 displayed table cells, and selected ablation/runtime claims.

[Download the release archive](https://github.com/dh-you/riemannian-crowd-sim/releases/tag/paper-eumas-2026-v1.0)
for the 20 full audit trajectories and both viewers. See
[extraction and reproduction instructions](../docs/reproduction.md).

The historical review record approves only the archived trajectories. New simulations
require their own review. PySocialForce entries in original build manifests are retained
as historical environment metadata; the published assignments use JuPedSim.

## Publication cleanup checks

`verification/scientific-regression.json` records agreement of all 20 seed-0
trajectories (39,600 complete engine-step records) and scalar scientific metrics
with the frozen reference. The report identifies the tested cleanup commit;
subsequent publication changes concern viewer packaging and documentation.
`verification/portable-viewer.json` records browser checks of all 20 full-rate
pages, including pre/post selection and seeking to the final frame.

The release additionally provides `audit/viewer-full-rate-portable/index.html`.
It loads one trajectory per page and avoids the original viewer's large-array
stack overflow. The original full-rate and sampled viewers remain unchanged
inside the archive. Viewer checks do not grant human approval to new runs.
