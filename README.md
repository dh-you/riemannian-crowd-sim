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
- `experiments/baselines/`: pinned ORCA/RVO2, PySocialForce, and candidate JuPedSim bootstrap, build, verification, adapters, licenses, and fixtures.
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
npm run jupedsim:audit
```

Bootstrap requires Git, Python, CMake, and a C++ compiler. Build additionally uses Ninja. These commands do not add npm dependencies or modify the system Python environment.

JuPedSim `1.4.2` is the active force-based lean-study baseline. PySocialForce remains in the repository for historical implementation/evidence compatibility but is not assigned by the final study.

## Lean study

`experiments/lean/study.json` is the authoritative study definition. Run phases explicitly; `--resume` reuses matching successful assignments, and `--jobs N` controls concurrency except for the single-job runtime phase.

```bash
npm run lean -- --phase audit
npm run lean -- --phase test --jobs 4
npm run lean -- --phase ablation --jobs 4
npm run lean -- --phase runtime --jobs 1
npm run lean -- --phase analyze
```

The active audit phase contains 28 assignments (20 paper-facing trajectories plus eight diagnostics) and packages a read-only viewer under `results/final-camera-ready-jupedsim/audit/viewer/`. Human approval is recorded in `results/final-camera-ready-jupedsim/audit/review-approved.txt` before later phases run. The five-scenario headline phase contains 280 assignments, the ablation phase 60, and the runtime phase 48 total assignments: 12 warmups and 36 measured runs.

The active paper-facing scenarios are exactly head-on, perpendicular crossing, circle antipodal, bidirectional corridor, and bottleneck. Head-on and crossing run for 30 seconds and use realized goal-disk entry. Circle retains individual antipodal point goals and uses a horizon no shorter than unobstructed ideal travel. Corridor navigation continues to the far goals at `x=+20` or `x=-20`, while paper completion is the correctly directed crossing of `x=+17` or `x=-17`. Bottleneck agents share waypoint `[1.5,0]` until strictly beyond `x=1`, then target lane-preserving goals `[10,initialY]`; completion is the positive crossing of `x=8`. Completion is independent of the legacy final point-goal arrival diagnostics. The exact interpolation and normalized-time definitions are in [docs/experiment-protocol.md](docs/experiment-protocol.md).

The isolated seed-400 completion audit can be reproduced with `npm run protocol:audit`; it writes only beneath `results/protocol-audit/completion-v2-current/` and does not touch canonical lean results.

The ablations are mechanically fixed to full, isotropic, no-closing-gate, and no-visibility-gate variants over head-on, crossing, and corridor scenarios. They reuse the same equations, smoothing, metrics, and output protocol as the lean runner.

## Fixed method configurations

The lean comparison fixes these configurations in `experiments/lean/study.json`:

- Conditioned Riemannian metric: `conditioned_riemannian_metric_v1`, velocity time constant `0.04`, `alpha=20`, `sigma=1.5`, `lambdaR=20`, `lambdaT=1`.
- Euclidean goal steering: `euclidean_goal_steering_v1`, velocity time constant `0.04`, with no free parameters.
- ORCA/RVO2: `neighborDist=5`, `maxNeighbors=16`, `timeHorizon=5`, `timeHorizonObst=5`.
- JuPedSim SocialForceModel: `bodyForce=120000`, `friction=240000`, `mass=80`, `reactionTime=0.5`, `agentScale=2000`, `obstacleScale=2000`, `forceDistance=0.08`; scenario radii and preferred speeds remain per-agent.

Do not substitute the standalone example configs under `experiments/methods/` for the fixed lean-study entries.

## Generated data and history

Large trajectories, raw run outputs, analysis products, baseline source checkouts, build products, and virtual environments are intentionally untracked. They remain under ignored local paths such as `results/` and `experiments/third_party/`; cleaning this branch does not remove them.

The completed Stage D implementation and its full orchestration history remain recoverable on the archived `scientific-results-stage-d` branch. This clean branch does not rewrite, delete, or modify that branch.
