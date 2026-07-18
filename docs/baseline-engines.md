# Baseline engine adapters

## Scope and architecture

Stage C integrates established ORCA and Social Force implementations without forcing either through `MotionController`. That interface returns a target velocity and is intentionally internal to `SimulatorCore`; its exponential smoothing and optional positional projection would change ORCA's selected velocity and replace Social Force's native acceleration dynamics.

The headless boundary is instead:

```text
ExperimentScenario
        |
ExperimentEngine
  |-- ScientificCoreEngine
  |     |-- Conditioned Riemannian
  |     `-- Goal+Projection
  |-- OrcaRvo2Engine
  `-- PySocialForceEngine
        |
EngineStepRecord v1
        |
RunMetricsAccumulator
```

Each engine owns stepping and goal-drive semantics. The evaluator consumes one common physical record per completed fixed step and has no engine-specific metric definitions.

This stage supplies provisional infrastructure defaults only. It does not tune any method, execute the frozen test protocol, or support comparative claims.

## Pinned upstreams, licenses, and patch

`experiments/baselines/third-party-lock.json` is authoritative.

| Dependency | Repository | Commit | License |
| --- | --- | --- | --- |
| RVO2 Library | `https://github.com/snape/RVO2.git` | `b577921d2bc1281a6b721c2d4778f397d37da97d` | Apache-2.0 |
| PySocialForce | `https://github.com/yuxiang-gao/PySocialForce.git` | `8c81cd1ed5db8d0e933417cec77954aa967d4459` | MIT |

Committed license copies are in `experiments/baselines/licenses/`. Full upstream trees are cloned into ignored directories and are not vendored.

RVO2 is unmodified. PySocialForce receives the locked patch in `experiments/baselines/patches/pysocialforce-goal-threshold.patch`. Bootstrap verifies the unpatched upstream suite first. The patch changes only:

1. `PedState` uses the existing `desired_force.goal_threshold` setting instead of a hard-coded 0.5 m stop distance. The adapter sets it to zero so only the common physical goal wrapper determines arrival.
2. `EnvState` samples at least both endpoints of every finite obstacle segment. The pinned source can otherwise produce an empty array for a short thick-wall rectangle end cap.

The lock records the patch SHA-256 and reason. Bootstrap refuses an absent, changed, or partially applied patch.

## Bootstrap, build, and verification

Prerequisites are Git, Python, CMake, Ninja, and a C++ compiler. Run:

```bash
npm run baselines:bootstrap
npm run baselines:build
npm run baselines:verify
```

Bootstrap checks out exact detached commits under `experiments/third_party/src/`, verifies upstream license files, creates `experiments/third_party/venv/`, and installs the exact packages in `requirements.lock`. It does not modify global Python. On the first patch application it temporarily installs test/plot dependencies, runs the unpatched upstream PySocialForce tests, removes those temporary dependencies, and only then applies the locked patch. Successful bootstrap is idempotent.

Build configures RVO2 and `orca_runner` in Release mode with OpenMP disabled and one build job. It verifies the dedicated Python runtime and writes `experiments/third_party/build/build-manifest.json`. The manifest records upstream SHAs, compiler and CMake identity, build type, Python executable/version/packages, platform, architecture, adapter-source hash, lock hash, runner paths/hashes, and timestamp.

Verify uses no network. It rejects source SHA, patch, license, lock, adapter, runner, environment, or build-manifest drift and runs small runner/import checks.

Generated locations are ignored:

```text
experiments/third_party/src/
experiments/third_party/build/
experiments/third_party/venv/
experiments/tmp/
```

## Common engine-step version 1

`EngineStepRecord` contains a zero-based step index, post-step physical time, ID-sorted agents, and physical diagnostics. Each agent exposes:

- position and realized velocity before the step;
- pre- and post-correction position;
- native `commandVelocity`;
- realized velocity from final displacement divided by `dt`;
- post-step arrival state.

Diagnostics retain separate agent/wall clearance and penetration, pre/post overlap counts, intended displacement, correction displacement by layer, and `correctionMode`. Values must be finite or explicitly `null`; NaN, Infinity, unknown versions, duplicate/out-of-order IDs, missing steps, and partial process output are rejected.

`commandVelocity` intentionally names related but non-identical native quantities:

- Scientific Core: controller target velocity before shared exponential smoothing.
- ORCA: RVO2-selected velocity used for its integration step.
- PySocialForce: native velocity after force integration and before its position update.

Pairwise avoidance onset uses this field. Smoothness uses realized velocity. Metrics consume every common step even when `trajectory.jsonl` is subsampled.

## Scientific Core adapter

`scientific_core_engine_v1` wraps the existing `SimulatorCore`; it does not duplicate it. It supports `conditioned_riemannian_metric_v1` and `euclidean_goal_steering_v1`. Target velocity becomes `commandVelocity`, and actual pre/post projection positions are retained.

Its correction mode is `shared_projection` when scenario correction is enabled and `disabled` otherwise. Regression tests compare direct Stage B.1 stepping and metrics with adapter output for free space, head-on, separating, circle, corridor, and bottleneck fixtures. The Riemannian equations and Goal+Projection controller semantics are unchanged.

## ORCA/RVO2 mapping

`orca_rvo2_engine_v1` supports method `orca_rvo2_v1`. `experiments/methods/orca-default.json` exposes:

- `neighborDist` -> RVO2 agent neighbor distance;
- `maxNeighbors` -> RVO2 maximum neighbors;
- `timeHorizon` -> agent time horizon;
- `timeHorizonObst` -> obstacle time horizon.

The experiment timestep is RVO2's timestep. Agents are added in ID order with scenario position, initial velocity, radius, and preferred speed. Maximum speed equals preferred speed. Before each native step, preferred velocity points directly at the current goal or is zero for a completed agent. There is no smoothing, random perturbation, or left/right bias.

Finite thick wall segments are sorted by wall ID and expanded by the shared utility into closed counterclockwise rectangles using half the thickness on each side. Each rectangle is added once and all RVO2 obstacles are processed before stepping. Agent radius remains unchanged, so wall thickness is not double-counted.

ORCA uses `correctionMode = "native_none"`: pre/post correction positions are identical and correction displacement is zero. Native overlap remains visible. RVO2 is built without OpenMP and output is deterministic on the same supported platform. The upstream engine uses single precision, so last-bit cross-compiler variation is possible.

Using RVO2 does not by itself justify a collision-free claim. ORCA guarantees depend on model assumptions, valid parameters, obstacle construction, numerical precision, and the absence of post-selection modifications.

## PySocialForce mapping

`pysocialforce_engine_v1` supports method `social_force_pysocialforce_v1`. The runner imports the pinned source without importing plotting modules. The actual enabled upstream classes are:

- `DesiredForce`;
- `SocialForce`;
- `ObstacleForce`.

`scene.enable_group = false`, so `GroupCoherenceForceAlt`, `GroupRepulsiveForce`, and `GroupGazeForceAlt` are not constructed. No group membership, learned potential, neural model, plotting, visualization, or stochastic noise is used.

The strict config maps adapter names to actual upstream keys:

| Adapter parameter | PySocialForce key |
| --- | --- |
| `desiredFactor` | `desired_force.factor` |
| `relaxationTime` | `desired_force.relaxation_time` |
| `socialFactor` | `social_force.factor` |
| `lambdaImportance` | `social_force.lambda_importance` |
| `gamma` | `social_force.gamma` |
| `n` | `social_force.n` |
| `nPrime` | `social_force.n_prime` |
| `obstacleFactor` | `obstacle_force.factor` |
| `obstacleSigma` | `obstacle_force.sigma` |
| `obstacleThreshold` | `obstacle_force.threshold` |
| `maxSpeedMultiplier` | root `max_speed_multiplier` |
| `obstacleResolution` | root `resolution` |

The pinned `PedState` reads `step_width`, `agent_radius`, and `max_speed_multiplier` at the TOML root, not under `[scene]`; the adapter follows that exact implementation. `step_width` is scenario `dt`. Initial position/velocity/goal are mapped directly. The per-agent preferred-speed array supplies upstream initial speeds, and its maximum-speed array is `preferredSpeed * maxSpeedMultiplier`.

The upstream implementation has one scalar `agent_radius`. The adapter maps the scenario radius exactly only when all radii are equal and rejects heterogeneous-radius scenarios clearly. It never silently discards a radius.

Expanded wall rectangle edges are passed to upstream `EnvState` as finite line segments. PySocialForce performs its native force and `PedState` integration once per scenario timestep. There is no Scientific Core smoothing, ORCA constraint, or positional projection. `correctionMode = "native_none"`; native contacts remain visible.

When an agent has already entered the experiment goal disk, the wrapper zeros its native velocity and temporarily sets its PySocialForce goal to its current position during force evaluation. This removes `DesiredForce` from the recorded post-arrival native command instead of merely resetting position afterward. The original goal is restored after the native step for provenance and state clarity.

PySocialForce is an implementation baseline, not evidence that provisional defaults are calibrated to human motion or that the resulting trajectories are realistic.

## Common goal-region wrapper

All methods use the physical arrival definition `distance(goal, position) <= goalTolerance`.

External engines give no further goal drive to an agent that starts inside the disk. When a proposed segment first enters the closed disk, the runner uses the first analytic segment-disk intersection, truncates position there, and derives realized velocity from actual displacement. A completed external agent is held stationary thereafter. External engines have no projection layer that could move it back out; this permanent deactivation differs deliberately from Scientific Core's post-correction arrival recomputation.

Pre-arrival native commands are not changed except for goal-entry truncation.

Pairwise avoidance onset is evaluated only while an agent has not previously arrived. A command produced after first arrival cannot create a new anticipation event.

## Native JSONL ingestion and continuity

ORCA and PySocialForce finish writing their native JSONL before Node consumes it, but ingestion is bounded: a synchronous 64 KiB chunk reader retains only one native step record plus the fixed buffer. The common resume validator uses the same bounded reader for finalized trajectories. Neither path loads or splits a complete trajectory file in memory.

Native agent order is protocol data, not repairable formatting. Every step must emit unique IDs in ascending order, exactly matching the scenario IDs. Step zero `positionBefore` must match the scenario start, and every later `positionBefore` must match that agent's previous final position within a scaled tolerance of `2e-7 * max(1 m, coordinate magnitude)`. This covers the pinned RVO2 adapter's float32 round-trip while remaining far below a physical timestep displacement. Count, ID-set, order, time, step-index, and position-continuity violations fail the run; no sorting is performed before validation.

## Identity, manifests, batch, and CSV

Method identity version 2 validates a config, constructs an ordered canonical object, lexicographically sorts parameter keys, serializes compact JSON with one LF, and hashes canonical UTF-8 bytes. Keys are:

```text
<method-id>--<first-12-hex-of-canonical-sha256>
```

Manifests separately record canonical and source-byte hashes. Formatting and line endings therefore do not change run identity, while source bytes remain auditable.

External runs fail before simulation unless lock, build manifest, runner, adapter, and upstream provenance agree. Manifests record engine ID/version, correction mode, command meaning, identity version/hashes, lock hash, upstream project/repository/commit/license, runner path/hash, build-manifest hash, and implementation limitations.

External adapter version 2 identifies the bounded-reader, continuity, and post-arrival hardening. Batch manifest version 4 uses the canonical key in output paths and records the build-manifest hash per run. Resume verifies scenario hash, canonical method identity, engine/adapter identity, third-party lock, upstream commit, runner hash, build-manifest hash, and repository Git SHA. This catches rebuilt Python environments or native packages even when runner source is unchanged. `--allow-cross-commit-resume` relaxes only repository Git SHA. Aggregation remains compatible with existing version-3 batch manifests. External stderr excerpts are recorded as batch failures.

Aggregation exposes common engine/provenance columns, nullable velocity smoothing, Riemannian parameters, ORCA parameters, actual enabled SFM parameters, separate raw/corrected safety, pairwise pre/post separation, completion, efficiency, correction dependence, smoothness, throughput, onset, and TTC. Inapplicable fields are empty CSV cells.

## Commands and current limits

Normal tests remain network- and baseline-independent:

```bash
npm test
```

Real integration tests and the seven-scenario/four-method smoke require successful bootstrap/build:

```bash
npm run test:baselines
npm run baselines:smoke
```

Committed controller-independent fixtures under `experiments/baselines/fixtures/` cover free space, offset head-on, crossing, separating, and finite-wall approach. The real-engine tests use those exact files for analytical, qualitative, finite-value, provenance, and repeatability checks.

The smoke covers free space, pairwise head-on/crossing/separating, small circle, small corridor, and small bottleneck using identical scenario bytes for all four methods.

Current limits are pinned upstream behavior, homogeneous PySocialForce radii, RVO2 single precision, and provisional untuned defaults. Parameter tuning, sensitivity analysis, frozen validation/test execution, confidence intervals, plots, tables, and scientific comparison are deferred.
