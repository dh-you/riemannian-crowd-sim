# Agent-Induced Riemannian Metric Fields for Crowd Simulation

A lightweight TypeScript implementation of an agent-induced Riemannian crowd controller. Nearby agents deform a local positive-definite metric, and inverse-metric descent steers each agent toward its unchanged goal while preserving the scientific core used in the EUMAS work.

Paper: [doi:10.1007/978-3-032-39395-1_42](https://doi.org/10.1007/978-3-032-39395-1_42) · [EUMAS 2026 evidence release](https://github.com/dh-you/riemannian-crowd-sim/releases/tag/paper-eumas-2026-v1.0) · [browser demo](https://dh-you.github.io/riemannian-crowd-sim/)

## Run the demo

Requires Node.js 22.12 or later.

```sh
npm ci
npm run dev
```

## Run experiments

Generate a scenario suite:

```sh
npm run exp:generate -- --suite experiments/suites/smoke-v1.json --out results/generated-smoke
```

Run one generated or hand-written scenario with a scientific method:

```sh
npm run exp:run -- \
  --scenario experiments/scenarios/pairwise-offset.json \
  --method experiments/methods/riemannian-default.json \
  --out results/pairwise-riemannian
```

Aggregate a directory of completed runs:

```sh
npm run exp:aggregate -- --input results/batch --out results/aggregate
```

The older core runner remains available for standalone scientific-core scenarios:

```sh
npm run core:run -- --scenario experiments/scenarios/pairwise-offset.json --out results/core-pairwise
```

Useful smoke checks are `npm run core:smoke` and `npm run exp:smoke`.

## Repository layout

| Location | Purpose |
|---|---|
| `src/core/` | Riemannian and Euclidean controllers, deterministic simulation, correction, validation |
| `src/demo/`, `pages/` | Interactive Three.js browser demo |
| `experiments/` | Scenario generation, pure-TypeScript engines, generic run/batch/aggregate CLI, metrics |
| `tests/` | Scientific-core and generic experiment-protocol tests |
| `docs/` | Scientific-core and experiment-protocol notes |

## Paper artifact and citation

The full EUMAS 2026 evidence tree, external baseline implementations, study runners, audit tooling, and provenance files are intentionally not carried on current `main`. They remain recoverable in Git history and in the [`paper-eumas-2026-v1.0`](https://github.com/dh-you/riemannian-crowd-sim/releases/tag/paper-eumas-2026-v1.0) release/tag.

See [`CITATION.cff`](CITATION.cff) for citation metadata.
