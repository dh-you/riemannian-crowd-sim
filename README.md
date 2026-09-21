# Agent-Induced Riemannian Metric Fields for Crowd Simulation

Nearby agents deform a local positive-definite metric. Inverse-metric descent
steers each agent toward an unchanged goal.

Paper: [doi:10.1007/978-3-032-39395-1_42](https://doi.org/10.1007/978-3-032-39395-1_42)
· [browser demo](https://dh-you.github.io/riemannian-crowd-sim/)
· [EUMAS 2026 evidence](https://github.com/dh-you/riemannian-crowd-sim/releases/tag/paper-eumas-2026-v1.0)

This tree is Riemannian + Euclidean goal-projection only. ORCA/RVO2 and JuPedSim
SocialForceModel live on the tagged evidence release, not on `main`.

## Demo

Requires Node.js 22.12 or later.

```sh
npm ci
npm run dev
```

## Experiments

```sh
npm test
npm run exp:generate -- --suite experiments/suites/smoke-v1.json --out results/generated-smoke
npm run exp:run -- --scenario experiments/scenarios/pairwise-offset.json --method experiments/methods/riemannian-default.json --out results/pairwise-riemannian
npm run exp:aggregate -- --input results/batch --out results/aggregate
```

Equations and metrics: [docs/scientific-core.md](docs/scientific-core.md),
[docs/experiment-protocol.md](docs/experiment-protocol.md).

## Layout

| Location | Purpose |
|---|---|
| `src/core/` | Controllers, deterministic simulation, correction |
| `src/demo/`, `pages/` | Three.js browser demo |
| `experiments/` | Scenario generation, engines, run/batch/aggregate CLI |
| `tests/` | Core and experiment-protocol tests |
