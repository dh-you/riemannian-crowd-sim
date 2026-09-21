# Agent-Induced Riemannian Metric Fields for Crowd Simulation

Research code and evidence for **Derek You**, *Multi-Agent Systems (EUMAS 2026)*,
LNAI 16829, Springer, 2027, pp. 1–6.
[Paper DOI](https://doi.org/10.1007/978-3-032-39395-1_42) ·
[Evidence release](https://github.com/dh-you/riemannian-crowd-sim/releases/tag/paper-eumas-2026-v1.0) ·
[Reproduction guide](docs/reproduction.md) ·
[Browser demo](https://dh-you.github.io/riemannian-crowd-sim/)

Nearby agents induce an anisotropic positive-definite metric. Inverse-metric
descent steers toward an unchanged goal potential. The commanded velocity is
speed-bounded and strictly goal-descending outside the goal region; smoothing
and positional correction can change the realized displacement.

## Paper results

The held-out study compares the Riemannian controller, Goal+Projection,
ORCA/RVO2, and **JuPedSim 1.4.2 SocialForceModel** over 70 scenarios (280 runs).
The separate ablation study contains 60 runs.

| Median completion | Ours | Goal+Projection | ORCA | JuPedSim |
|---|---:|---:|---:|---:|
| Corridor | .842 | .996 | .608 | .471 |
| Bottleneck | 1.000 | 1.000 | .732 | .862 |

Ours has zero median raw penetration in the pairwise settings and reduces
dense overlap and correction dependence relative to Goal+Projection. ORCA and
JuPedSim maintain stronger dense separation. Exact head-on symmetry remains
unresolved; dense overlap persists and parameters are not human-calibrated.
See [the complete table and evidence mapping](paper/README.md).

![Paper evaluation geometries and head-on trajectories](paper/figures/figure-1.png)

## Reproduce

The full native pipeline is pinned to **Windows x64, CPython 3.12, MinGW-w64
G++, CMake, and Ninja**. Use Node.js 22.12 or later. The TypeScript tests and
demo build also run in Linux CI; that does not establish Linux baseline support.

```sh
npm ci
npm test
npm run build
npm run baselines:bootstrap
npm run baselines:build
npm run baselines:verify
npm run test:baselines
npm run paper:audit -- --out results/reproduction
```

Review the generated trajectories, then follow the [human review and study
steps](docs/reproduction.md). New runs write to `results/reproduction` by
default. Published evidence remains separate and its historical approval does
not authorize a new reproduction. To verify the compact evidence without
installing native baselines, run `npm run paper:verify` (Python 3 required).

## Repository layout

| Location | Purpose |
|---|---|
| `src/core/` | Paper controller, deterministic integration, and correction |
| `experiments/` | Frozen study, generators, baseline adapters, metrics, analysis |
| `paper/` | Published summaries, figures, configuration, provenance, checksums |
| `src/demo/`, `pages/` | Legacy interactive browser demonstrator |
| `tests/` | Scientific, protocol, study, and native-engine regression tests |
| `docs/` | Equations, experiment protocol, dependencies, and reproduction |

Run `npm run dev` for the demo. **The browser demonstrator uses a separate
legacy implementation and different scenario sizes; it is not the source of
the paper's results.** Use the release's trajectory viewers to inspect the
actual experiment runs. Existing demo page URLs are preserved.

## Version and citation

The experiments were generated at scientific reference commit
[`05241d5`](https://github.com/dh-you/riemannian-crowd-sim/commit/05241d55a90a7b873d0a403a30682e8577f8111d).
The `paper-eumas-2026-v1.0` release records the later publication-cleanup commit
separately; it does not relabel historical runs. See [CITATION.cff](CITATION.cff).

Older Stage A–D studies and PySocialForce remain in Git history; see
[historical implementations](docs/history.md). PySocialForce is not an active
paper baseline. Historical method schemas remain readable for provenance.

No license for the original project code is added by this release. Third-party
licenses are retained under `experiments/baselines/licenses/`; see
[baseline dependencies](docs/baseline-engines.md).
