# Agent-Induced Riemannian Metric Fields for Crowd Simulation

[Derek You](https://dh-you.github.io/)

**European Conference on Multi-Agent Systems (EUMAS) 2026**

[![Paper (DOI)](https://img.shields.io/badge/Paper-DOI-b31b1b)](https://doi.org/10.1007/978-3-032-39395-1_42)
[![Project Page](https://img.shields.io/badge/Project-Page-4488ff)](https://dh-you.github.io/riemannian-crowd-sim/)
[![Evidence](https://img.shields.io/badge/Evidence-Release-green)](https://github.com/dh-you/riemannian-crowd-sim/releases/tag/paper-eumas-2026-v1.0)
[![Demo](https://img.shields.io/badge/Demo-Live-9b59b6)](https://dh-you.github.io/riemannian-crowd-sim/pages/demo.html)

## Abstract

Nearby agents deform a local positive-definite metric. Inverse-metric descent steers each agent toward an unchanged goal. This approach encodes agent-agent interactions directly into the geometry of the space, rather than through explicit collision avoidance or force-based repulsion.

## Quick Start

```sh
npm ci
npm run dev
```

Run experiments:

```sh
npm test
npm run exp:generate -- --suite experiments/suites/smoke-v1.json --out results/generated-smoke
npm run exp:run -- --scenario experiments/scenarios/pairwise-offset.json --method experiments/methods/riemannian-default.json --out results/pairwise-riemannian
npm run exp:aggregate -- --input results/batch --out results/aggregate
```

## Repository Layout

| Path | Purpose |
|---|---|
| `src/core/` | Controllers, deterministic simulation, correction |
| `src/demo/`, `pages/` | Three.js browser demo |
| `experiments/` | Scenario generation, engines, run/batch/aggregate CLI |
| `docs/` | Scientific core equations and experiment protocol |
| `tests/` | Core and experiment-protocol tests |
| `public/` | Static assets for the demo |

See [docs/scientific-core.md](docs/scientific-core.md) for equations and [docs/experiment-protocol.md](docs/experiment-protocol.md) for the experiment protocol.

This tree is Riemannian + Euclidean goal-projection only. ORCA/RVO2 and JuPedSim SocialForceModel live on the [tagged evidence release](https://github.com/dh-you/riemannian-crowd-sim/releases/tag/paper-eumas-2026-v1.0), not on `main`.

## Citation

```bibtex
@inproceedings{you2026riemannian,
  title={Agent-Induced {R}iemannian Metric Fields for Crowd Simulation},
  author={You, Derek},
  booktitle={European Conference on Multi-Agent Systems (EUMAS)},
  year={2026},
  doi={10.1007/978-3-032-39395-1_42},
  publisher={Springer}
}
```
