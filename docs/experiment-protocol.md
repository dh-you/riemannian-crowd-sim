# Experiment protocol

The generic experiment layer keeps physical scenarios separate from controller configuration. Scenario generators produce deterministic JSON inputs; the same scenario bytes can then be run with either scientific TypeScript method: the conditioned Riemannian controller or Euclidean goal steering with projection.

## Methods

Method configurations live in `experiments/methods/` and use `methodConfigVersion: 1`.

- `riemannian-default.json` selects `conditioned_riemannian_metric_v1` and supplies `alpha`, `sigma`, `lambdaR`, `lambdaT`, and the velocity time constant.
- `goal-projection.json` selects `euclidean_goal_steering_v1` with the same scientific simulation core and correction machinery.

Each validated configuration receives a canonical SHA-256 identity and a hash-qualified method key. Source formatting does not change the canonical identity.

## Scenarios and completion

Scenario JSON is controller-independent. It records agents, walls, timestep and horizon, correction settings, navigation rules, completion rules, metadata, and seed. Generators live in `experiments/generation/`, and example suites live in `experiments/suites/`.

The completion protocol is implemented in `experiments/protocol/completion.ts`. Segment intersection interpolates completion time within a step, so completion is based on realized motion rather than only the final sampled position.

## Running

Generate a deterministic suite:

```sh
npm run exp:generate -- --suite experiments/suites/smoke-v1.json --out results/generated-smoke
```

Run one scenario-method pair:

```sh
npm run exp:run -- \
  --scenario experiments/scenarios/pairwise-offset.json \
  --method experiments/methods/riemannian-default.json \
  --out results/pairwise-riemannian
```

For multiple scenarios, `npm run exp:batch` drives repeated runs. Aggregate completed run directories with:

```sh
npm run exp:aggregate -- --input results/batch --out results/aggregate
```

`npm run exp:smoke` exercises the headless generate/run/aggregate path with scientific methods only.

## Metrics and outputs

A completed experiment run writes a manifest, streamed trajectory JSONL, summary, and `run-metrics.json`. Metrics include completion, normalized completion time where applicable, pre/post-correction separation diagnostics, penetration and overlap exposure, correction dependence, smoothness, and throughput-related quantities.

`exp:aggregate` converts completed run metrics into tabular outputs such as `run-metrics.csv`. Generated `results/` content is not part of the repository.

The external baselines and frozen EUMAS study machinery are archival rather than part of current `main`; see the `paper-eumas-2026-v1.0` release/tag for the publication artifact.
