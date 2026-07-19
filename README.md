# Riemannian crowd simulation

This repository contains an interactive browser demonstrator and a reproducible scientific pipeline for comparing a conditioned Riemannian crowd controller with Euclidean goal steering, ORCA/RVO2, and PySocialForce. It includes the scientific core, corrected scenario generators, pinned baseline adapters, the four-method lean study, its local trajectory-review viewer, and regression tests.

## Browser demo

Install the JavaScript dependencies and start Vite:

```bash
npm ci
npm run dev
```

The landing page links to the two-agent, overtaking, bidirectional corridor, six-wall bottleneck, antipodal circle, and frame-rate demonstrations. Production assets can be built and previewed with:

```bash
npm run build
npm run preview
```

## Scientific method

The scientific core advances deterministic, fixed-timestep scenarios through an explicit motion controller, velocity smoothing, contact diagnostics, and shared positional correction. The conditioned Riemannian controller constructs a local anisotropic metric from nearby agents and maps goal motion through that metric. Scenario generation, method identity, engine adapters, trajectory records, and metrics are separated so that every run records the configuration and implementation used.

The repository supports the completed experiment; it does not infer new claims from the code. See [scientific-core.md](docs/scientific-core.md), [experiment-protocol.md](docs/experiment-protocol.md), and [baseline-engines.md](docs/baseline-engines.md) for implementation and protocol details.

## Repository layout

- `src/`: browser simulation and the reusable scientific core.
- `pages/` and `public/`: browser entry points and assets.
- `experiments/generation/`: deterministic scenario generators, including the corrected six-wall bottleneck.
- `experiments/engines/`, `metrics/`, `protocol/`, and `output/`: execution adapters, measurements, validation, identities, and records.
- `experiments/baselines/`: pinned ORCA/RVO2 and PySocialForce bootstrap, build, verification, adapters, licenses, and fixtures.
- `experiments/lean/`: lean-study definition, runner, analysis, audited execution, and reusable ablation implementation.
- `experiments/audit/viewer/`: local, read-only trajectory-review viewer used by the lean audit phase.
- `tests/`: browser-independent core, experiment, baseline, lean, viewer, generator, and ablation regression tests.

## Install and test

Node.js 20 or newer is recommended.

```bash
npm ci
npm run build
npm test
```

Useful scientific-core commands are `npm run core:smoke`, `npm run core:run -- --scenario <file> --out <directory>`, and `npm run exp:smoke`.

## Baseline engines

The external engines are locked to exact upstream commits and use work directories under `experiments/third_party/`, which Git ignores. Prepare and validate them with:

```bash
npm run baselines:bootstrap
npm run baselines:build
npm run baselines:verify
npm run test:baselines
```

Bootstrap requires Git, Python, CMake, and a C++ compiler. Build additionally uses Ninja. These commands do not add npm dependencies or modify the system Python environment.

## Lean study

`experiments/lean/study.json` is the authoritative study definition. Run phases explicitly; `--resume` reuses matching successful assignments, and `--jobs N` controls concurrency except for the single-job runtime phase.

```bash
npm run lean -- --phase audit
npm run lean -- --phase test --jobs 4
npm run lean -- --phase ablation --jobs 4
npm run lean -- --phase runtime --jobs 1
npm run lean -- --phase analyze
```

The audit phase contains 32 assignments and packages a read-only viewer under `results/lean/audit/viewer/`. A human must inspect the trajectories and create a nonempty `results/lean/audit/review-approved.txt` before later phases will run. `npm run audit:viewer` rebuilds the viewer from existing lean audit outputs. The headline phase contains 360 assignments, the ablation phase 60, and the runtime phase 48 total assignments: 12 warmups and 36 measured runs.

The ablations are mechanically fixed to full, isotropic, no-closing-gate, and no-visibility-gate variants over head-on, crossing, and corridor scenarios. They reuse the same equations, smoothing, metrics, and output protocol as the lean runner.

## Fixed method configurations

The lean comparison fixes these configurations in `experiments/lean/study.json`:

- Conditioned Riemannian metric: `conditioned_riemannian_metric_v1`, velocity time constant `0.04`, `alpha=20`, `sigma=1`, `lambdaR=20`, `lambdaT=1`.
- Euclidean goal steering: `euclidean_goal_steering_v1`, velocity time constant `0.04`, with no free parameters.
- ORCA/RVO2: `neighborDist=5`, `maxNeighbors=16`, `timeHorizon=5`, `timeHorizonObst=5`.
- PySocialForce: `desiredFactor=1`, `relaxationTime=0.5`, `socialFactor=5.1`, `lambdaImportance=2`, `gamma=0.35`, `n=2`, `nPrime=3`, `obstacleFactor=10`, `obstacleSigma=0.2`, `obstacleThreshold=3`, `maxSpeedMultiplier=1.3`, `obstacleResolution=10`.

Do not substitute the standalone example configs under `experiments/methods/` for the fixed lean-study entries.

## Generated data and history

Large trajectories, raw run outputs, analysis products, baseline source checkouts, build products, and virtual environments are intentionally untracked. They remain under ignored local paths such as `results/` and `experiments/third_party/`; cleaning this branch does not remove them.

The completed Stage D implementation and its full orchestration history remain recoverable on the archived `scientific-results-stage-d` branch. This clean branch does not rewrite, delete, or modify that branch.
