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
  |-- PySocialForceEngine
  `-- JuPedSimSfmEngine
        |
EngineStepRecord v2
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
| JuPedSim | `https://github.com/PedestrianDynamics/jupedsim` | PyPI wheel `jupedsim-1.4.2-cp312-cp312-win_amd64.whl`, SHA-256 `9bc43cc6a6bbf4e3a5b7fd82f835a879dea2205e3499cd0c2bcb11b0371d8408` | LGPL-3.0-or-later |

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

Bootstrap checks out exact detached commits under `experiments/third_party/src/`, verifies upstream license files, creates `experiments/third_party/venv/`, and installs the exact PySocialForce packages in `requirements.lock`. It also creates the separate ignored `experiments/third_party/jupedsim-venv/`, downloads only the official compatible Windows binary wheel, verifies its locked SHA-256, and installs JuPedSim plus every declared dependency using `--require-hashes --only-binary=:all:`. It does not modify global Python. On the first patch application it temporarily installs test/plot dependencies and runs the unpatched upstream PySocialForce tests. Because those tests rewrite tracked reference images, bootstrap then removes the temporary dependencies, restores the exact locked checkout, deletes generated tracked/untracked/ignored artifacts, verifies the source tree is clean, and only then applies the locked patch. Destructive Git restoration is accepted only for the exact locked source directory beneath the managed third-party source root, with the expected `.git` metadata and locked HEAD. Successful bootstrap is idempotent.

Build configures RVO2 and `orca_runner` in Release mode with OpenMP disabled and one build job. It verifies the dedicated Python runtime and writes `experiments/third_party/build/build-manifest.json`. The manifest records upstream SHAs, compiler and CMake identity, build type, Python executable/version/packages, platform, architecture, adapter-source hash, lock hash, runner paths/hashes, and timestamp.

Verify uses no network. It rejects source SHA, patch, license, lock, adapter, runner, environment, or build-manifest drift and runs small runner/import checks.

Generated locations are ignored:

```text
experiments/third_party/src/
experiments/third_party/build/
experiments/third_party/venv/
experiments/third_party/jupedsim-venv/
experiments/tmp/
```

## Common engine-step version 2

`EngineStepRecord` contains a zero-based step index, post-step physical time, ID-sorted agents, and physical diagnostics. Each agent exposes:

- position and realized velocity before the step;
- pre- and post-correction position;
- the shared current `navigationTarget` used for that step;
- native `commandVelocity`;
- realized velocity from final displacement divided by `dt`;
- post-step arrival state.

Diagnostics retain separate agent/wall clearance and penetration, pre/post overlap counts, intended displacement, correction displacement by layer, and `correctionMode`. Values must be finite or explicitly `null`; NaN, Infinity, unknown versions, duplicate/out-of-order IDs, missing steps, and partial process output are rejected.

`commandVelocity` intentionally names related but non-identical native quantities:

- Scientific Core: controller target velocity before shared exponential smoothing.
- ORCA: RVO2-selected velocity used for its integration step.
- PySocialForce: native velocity after force integration and before its position update.
- JuPedSim: native `SocialForceModel` velocity after the native iteration.

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

The experiment timestep is RVO2's timestep. Agents are added in ID order with scenario position, initial velocity, radius, and preferred speed. Maximum speed equals preferred speed. Before each native step, preferred velocity points directly at the shared protocol target or is zero for an agent that has reached its final point goal. Point-goal arrival remains separate from directional paper completion. There is no smoothing, random perturbation, or left/right bias.

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

The pinned `PedState` reads `step_width`, `agent_radius`, and `max_speed_multiplier` at the TOML root, not under `[scene]`; the adapter follows that exact implementation. `step_width` is scenario `dt`. Initial position, velocity, final point goal, and the shared current navigation target are mapped explicitly. The per-agent preferred-speed array supplies upstream initial speeds, and its maximum-speed array is `preferredSpeed * maxSpeedMultiplier`.

The upstream implementation has one scalar `agent_radius`. The adapter maps the scenario radius exactly only when all radii are equal and rejects heterogeneous-radius scenarios clearly. It never silently discards a radius.

Expanded wall rectangle edges are passed to upstream `EnvState` as finite line segments. PySocialForce performs its native force and `PedState` integration once per scenario timestep. There is no Scientific Core smoothing, ORCA constraint, or positional projection. `correctionMode = "native_none"`; native contacts remain visible.

When an agent has already entered its final point-goal disk, the wrapper zeros its native velocity and temporarily sets its PySocialForce goal to its current position during force evaluation. This removes `DesiredForce` from the recorded post-arrival native command instead of merely resetting position afterward. Otherwise its upstream goal is the shared protocol target for that step. The final point goal remains separately available for arrival and provenance.

PySocialForce is an implementation baseline, not evidence that provisional defaults are calibrated to human motion or that the resulting trajectories are realistic.

## JuPedSim SocialForceModel mapping

`jupedsim_sfm_engine_v1` supports method `social_force_jupedsim_v1` (active study key `jupedsim-sfm`). The implementation is pinned to JuPedSim `1.4.2` and uses the package-default `SocialForceModel` values `body_force=120000` and `friction=240000`. Per-agent package defaults fixed in the strict method config are `mass=80`, `reaction_time=0.5`, `agent_scale=2000`, `obstacle_scale=2000`, and `force_distance=0.08`. Radius, desired speed, position, velocity, orientation, and navigation target always come from the scenario.

The runner creates `Simulation(..., dt=scenario.dt / 2)`, exactly one direct-steering stage, and one journey containing only that stage. Each common experiment step resolves and assigns the canonical target once, holds it fixed, and performs exactly two deterministic native half-step iterations. It then emits one common record at `scenario.dt`. Initial orientation is normalized initial velocity when nonzero, otherwise normalized current protocol target minus position, otherwise `[1,0]`. A stable explicit map relates scenario IDs to JuPedSim IDs. Every native substep must retain the complete agent set; duplicate, missing, unexpected, disappearing, nonfinite, or unmappable agents fail.

At the beginning of every common step the runner resolves and assigns the existing completion-v2 target for every agent, then holds that target across both internal substeps. Head-on, crossing, circle, and corridor use their point goals (including corridor `x=+20` or `x=-20`). Bottleneck uses shared `[1.5,0]` while the outer-step starting `position.x <= 1`, then the individual `[10,initialY]` goal. JuPedSim direct steering uses its native geometry-aware shortest path to that shared target; it receives no private opening, waypoint, routing stage, group, or random force. Paper completion remains the common completion-v2 metric and never uses JuPedSim stage completion. Direct steering does not automatically remove agents, and the adapter never requests removal.

Walkable geometry starts from a deterministic counterclockwise outer rectangle with a fixed 5 m margin around every initial position, point goal, possible protocol waypoint, and expanded wall vertex. The existing thick-wall expansion is authoritative. Its sorted wall rectangles are subtracted with the JuPedSim-supported Shapely geometry path, and the unique connected component containing all initial centers is selected. Every initial center, point goal, and protocol waypoint must be strictly inside that component or the run fails. The six bottleneck walls therefore isolate the chamber from the exterior while leaving only the shared central divider opening. A SHA-256 over the canonical construction record is stored per run; the runner additionally hashes the normalized selected native geometry.

JuPedSim uses `correctionMode = "native_none"`. There is no Scientific Core smoothing/correction, custom overlap projection, external velocity clamp, post-step position correction, goal-disk truncation, speed cap, force clamp, damping term, or emergency collision correction. The emitted command velocity is the final native model velocity after both substeps; realized velocity is the total native displacement divided by the full common outer timestep. Provenance explicitly records `experimentDt`, `nativeJuPedSimDt`, and `nativeSubstepsPerExperimentStep` and describes deterministic internal integration substepping for numerical stability of the stiff contact-force model. Paper RMS acceleration and every other paper metric remain computed from common outer-step records; native-substep peak speed and acceleration are artifact diagnostics only. Runtime measurements include the full cost of both native substeps without division or normalization. Provenance also records the exact package/Python/platform identity, wheel and requirement-lock hashes, installation command, runner/method/geometry hashes, direct-steering use, scenario radii/preferred speeds, completion protocol, upstream project, and LGPL license. These package-default force coefficients are untuned and are not a realism or calibration claim.

## Point-goal wrapper and paper completion

All methods retain the physical final-point arrival definition `distance(goal, position) <= goalTolerance`. This is the meaning of `AgentState.arrived` and native `arrived`; it is not the paper-facing completion source for directional-line scenarios.

External engines give no further goal drive to an agent that starts inside the disk. When a proposed segment first enters the closed disk, the runner uses the first analytic segment-disk intersection, truncates position there, and derives realized velocity from actual displacement. A completed external agent is held stationary thereafter. External engines have no projection layer that could move it back out; this permanent deactivation differs deliberately from Scientific Core's post-correction arrival recomputation.

Pre-arrival native commands are not changed except for goal-entry truncation and the shared scenario-defined navigation target. Paper completion is evaluated separately from the realized previous-committed to post-correction segment and never deactivates an agent.

Pairwise avoidance onset is evaluated only while an agent has not previously arrived. A command produced after first arrival cannot create a new anticipation event.

## Native JSONL ingestion and continuity

ORCA, PySocialForce, and JuPedSim finish writing their native JSONL before Node consumes it, but ingestion is bounded: a synchronous 64 KiB chunk reader retains only one native step record plus the fixed buffer. The common resume validator uses the same bounded reader for finalized trajectories. Neither path loads or splits a complete trajectory file in memory.

Native agent order is protocol data, not repairable formatting. Every step must emit unique IDs in ascending order, exactly matching the scenario IDs. Step zero `positionBefore` must match the scenario start, and every later `positionBefore` must match that agent's previous final position within a scaled tolerance of `2e-7 * max(1 m, coordinate magnitude)`. The emitted navigation target must match the shared resolver within the same tolerance on every step. This covers the pinned RVO2 adapter's float32 round-trip while remaining far below a physical timestep displacement. Count, ID-set, order, time, step-index, position-continuity, and target violations fail the run; no sorting or repair is performed before validation.

## Identity, manifests, batch, and CSV

Method identity version 2 validates a config, constructs an ordered canonical object, lexicographically sorts parameter keys, serializes compact JSON with one LF, and hashes canonical UTF-8 bytes. Keys are:

```text
<method-id>--<first-12-hex-of-canonical-sha256>
```

Manifests separately record canonical and source-byte hashes. Formatting and line endings therefore do not change run identity, while source bytes remain auditable.

External runs fail before simulation unless lock, build manifest, runner, adapter, and upstream provenance agree. Manifests record engine ID/version, correction mode, command meaning, identity version/hashes, lock hash, upstream project/repository/commit/license, runner path/hash, build-manifest hash, and implementation limitations.

External adapter version 3 identifies shared protocol-target support in addition to the bounded-reader, continuity, and post-arrival hardening. Batch manifest version 4 uses the canonical key in output paths and records the build-manifest hash per run. Resume verifies scenario hash, canonical method identity, engine/adapter identity, third-party lock, upstream commit, runner hash, build-manifest hash, and repository Git SHA. This catches rebuilt Python environments or native packages even when runner source is unchanged. `--allow-cross-commit-resume` relaxes only repository Git SHA. Aggregation remains compatible with existing version-3 batch manifests. External stderr excerpts are recorded as batch failures.

Aggregation exposes common engine/provenance columns, nullable velocity smoothing, Riemannian parameters, ORCA parameters, actual enabled SFM parameters, separate raw/corrected safety, pairwise pre/post separation, completion, efficiency, correction dependence, smoothness, throughput, onset, and TTC. Inapplicable fields are empty CSV cells.

## Commands and current limits

Normal tests remain network- and baseline-independent:

```bash
npm test
```

Real integration tests and the seven-scenario/five-method development smoke require successful bootstrap/build:

```bash
npm run test:baselines
npm run baselines:smoke
npm run jupedsim:audit
```

Committed controller-independent fixtures under `experiments/baselines/fixtures/` cover free space, offset head-on, crossing, separating, and finite-wall approach. The real-engine tests use those exact files for analytical, qualitative, finite-value, provenance, and repeatability checks.

The smoke covers free space, pairwise head-on/crossing/separating, small circle, small corridor, and small bottleneck using identical scenario bytes for all five currently available methods. `jupedsim:audit` is separate: it runs only JuPedSim for the five paper-facing scenarios at seed 400 and writes beneath `results/jupedsim-integration/audit-v2/`.

Current limits are pinned upstream behavior, homogeneous PySocialForce radii, RVO2 single precision, and provisional untuned defaults. Parameter tuning, sensitivity analysis, frozen validation/test execution, confidence intervals, plots, tables, and scientific comparison are deferred.
