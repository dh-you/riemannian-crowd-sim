# Deterministic experiment protocol

## Architecture and scope

Stage B separates five concerns that must remain independently auditable:

1. An experiment scenario describes only the shared physical problem: agents, finite walls, units, fixed timestep, horizon, goal tolerance, and correction settings.
2. A method configuration selects a controller, its parameters, and its velocity-smoothing time constant.
3. A controller computes only an agent's target velocity from an immutable step snapshot.
4. `SimulatorCore` supplies the same synchronous smoothing, goal-disk truncation, arrival recomputation, correction, wall handling, realized velocity, and diagnostics for every controller.
5. `RunMetricsAccumulator` consumes every completed step online, independently of trajectory recording frequency.

The same scenario JSON is passed unchanged to every method. This prevents method-specific configuration from changing initial states or physical settings and lets manifests verify shared input through the same scenario SHA-256.

The Stage A `schemaVersion: 1` format and `core:run` remain supported without reinterpretation. The experiment protocol is a separate schema.

## Methods and configuration

Method configs use `methodConfigVersion: 1`. Stable machine IDs and display labels are:

| Machine ID | Paper-facing label |
| --- | --- |
| `conditioned_riemannian_metric_v1` | Conditioned Riemannian |
| `euclidean_goal_steering_v1` | Goal+Projection |

The Conditioned Riemannian implementation retains the Stage A equations and numerical operations documented in [scientific-core.md](scientific-core.md). The controller refactor delegates the same metric construction and inverse-metric target calculation through a common interface; it does not change goal-direction visibility, signed closing, Wendland weighting, tensor construction, solve-based steering, normalization, or ID-ordered accumulation.

For Goal+Projection, an agent outside the goal tolerance receives

\[
v_i^\star=s_i\frac{q_i-p_i}{\lVert q_i-p_i\rVert},
\]

and an agent inside receives zero. It ignores neighbors, has interaction radius zero, and has no interaction parameters or lateral bias. “Projection” refers only to the optional shared positional correction layer; correction is not part of this controller.

The committed configs in `experiments/methods/` are provisional infrastructure defaults. They are not tuned or selected paper parameters.

## Experiment scenario version 1

An `experimentScenarioVersion: 1` document contains:

- `name`, `family`, `variant`, `split`, and an integer `seed`;
- `simulation.dt`, `horizonSeconds`, `goalTolerance`, and correction configuration;
- agents with unique safe-integer IDs, positive radius and preferred speed, and finite 2D position, velocity, and goal;
- finite, nondegenerate wall segments with unique safe-integer IDs and nonnegative thickness;
- explicit distance unit `m` and time unit `s`.

It contains no controller parameters, smoothing time constant, or method label. Parsing is strict: unknown fields, unsupported versions, non-finite values, malformed vectors, invalid IDs, duplicate IDs, invalid physical quantities, and degenerate walls are rejected. No malformed value receives a default.

## Deterministic generation

`DeterministicRandom` is a repository-owned Mulberry32 generator. Its state and output are unsigned 32-bit integers; `nextFloat()` is exactly the output integer divided by \(2^{32}\), producing a value in \([0,1)\). No generator uses `Math.random()`, time, the OS, or a platform-specific entropy source. A committed integer golden sequence prevents silent algorithm changes.

Generator version `protocol_v1` writes ID-sorted, stable pretty JSON with no timestamp. Each scenario is checked for initial agent-agent and agent-wall physical overlap with a \(10^{-10}\) m numerical tolerance. `suite-manifest.json` records identity, population, generator and suite versions, scenario SHA-256, suite-definition hash, and Git SHA when available. Regenerating a suite produces byte-identical scenario files.

Defaults are metric-scale navigation fixtures, not human calibration: radius 0.3 m, preferred speed centered at 1.4 m/s with approximately ±10% variation, timestep 1/60 s, and correction padding 0.001 m.

### Scenario families

- Pairwise: seeded `head_on`, `crossing`, `overtaking`, and `separating` encounters. The separate `exact_symmetric_diagnostic` exposes the controller's left/right symmetry limitation and is excluded from statistical splits.
- Circle antipodal: near-even circular placement with antipodal goals and small angular/speed perturbations. Validation uses 50 agents and test uses 100.
- Bidirectional flow: two equal counter-moving populations in a finite-wall corridor. Validation uses 120 agents and test uses 240; goals lie beyond the opposite interaction boundary.
- Bottleneck: one population approaches a central finite-wall opening. Opening width, initial spacing (density), spawn jitter, and speed heterogeneity are generator parameters. Defaults produce 112 validation agents and 224 test agents with goals beyond the exit.

### Seed split

Validation pairwise cases use seeds 0–9; circle, bidirectional, and bottleneck use seeds 0–4. Test pairwise cases use seeds 1000–1049; circle, bidirectional, and bottleneck use seeds 1000–1029. These sets are disjoint. The complete definition contains 346 scenarios, including one seed-independent diagnostic, but Stage B validation does not execute the full test split.

Committed fixtures under `experiments/fixtures/protocol-v1/` include the exact diagnostic and seed 0 validation output for every family.

## Online metrics

Metrics consume every simulator step, even when `trajectory.jsonl` is subsampled.

First arrival is the first post-correction step for which `arrived` is true. It is recorded by the accumulator only; simulator arrival remains recomputed and unlatching. Success is the fraction that arrived at least once, while final-arrived fraction describes only the last state.

For successful agent \(i\), normalized travel time and path ratio are

\[
T_i^{\mathrm{norm}}=\frac{T_i^{\mathrm{arrival}}}{\lVert q_i-p_i^0\rVert/s_i},
\qquad
E_i^{\mathrm{path}}=\frac{L_i^{\mathrm{realized}}}{\lVert q_i-p_i^0\rVert}.
\]

Realized path length stops at first arrival. Per-agent values plus mean and median are written; unavailable aggregates are `null`.

Separation metrics are minimum pre-correction physical clearance, pre/post overlap pair-seconds, pre-correction pair-seconds per agent-second, and maximum pre/post penetration. Physical overlap excludes correction padding.

Correction metrics sum intended, agent-correction, wall-correction, and total-correction displacement over all agents and steps. The ratio is

\[
D_{\mathrm{correction}}/(D_{\mathrm{intended}}+10^{-12}\ \mathrm m).
\]

Smoothness uses realized velocity and physical timestep. The initial scenario velocity precedes the first acceleration sample. Each active agent-step contributes one squared vector magnitude; RMS acceleration is the square root of the sum divided by the number of acceleration vector samples. Jerk is aggregated identically over consecutive acceleration samples. An agent contributes no later samples after first arrival. A missing denominator yields `null`.

Throughput is first arrivals divided by simulated seconds; it is `null` at zero duration.

### Pairwise anticipation

The unobstructed direction is \(u_i^0=(q_i-p_i)/\lVert q_i-p_i\rVert\). Avoidance onset is the first step-start time when

\[
\delta_i=\cos^{-1}\!\left(\frac{v_i^\star\cdot u_i^0}{\lVert v_i^\star\rVert}\right)>5^\circ.
\]

Zero target velocity or an undefined goal direction does not declare onset. At onset, TTC solves \(\lVert r+tv\rVert^2=R^2\) and stores the earliest nonnegative finite root. Separating, stationary, invalid, or non-collision trajectories yield `null`; already overlapping circles yield zero. Pairwise output also reports minimum center distance and minimum physical clearance.

## Running experiments

Generate the deterministic protocol:

```bash
npm run exp:generate -- --suite experiments/suites/protocol-v1.json --out experiments/generated/protocol-v1
```

Run one scenario with either method:

```bash
npm run exp:run -- --scenario experiments/generated/protocol-v1/validation/pairwise/head_on/seed-0.json --method experiments/methods/riemannian-default.json --out results/stage-b-riemannian-example
npm run exp:run -- --scenario experiments/generated/protocol-v1/validation/pairwise/head_on/seed-0.json --method experiments/methods/goal-projection.json --out results/stage-b-goal-example
```

The runner writes atomic `manifest.json`, `trajectory.jsonl`, `summary.json`, and `run-metrics.json`. The manifest records schema versions, controller ID/label, exact method settings, scenario and config hashes, platform, Git SHA, arguments, and execution time. Trajectory records are controller-independent and ID-sorted. `--record-every N` changes trajectory density but not metrics.

Run the CI-sized cross-method smoke suite:

```bash
npm run exp:smoke
```

Run a split sequentially and aggregate it:

```bash
npm run exp:batch -- --suite experiments/generated/protocol-v1/suite-manifest.json --methods experiments/methods/riemannian-default.json,experiments/methods/goal-projection.json --split validation --out results/protocol-v1-validation
npm run exp:aggregate -- --input results/protocol-v1-validation --out results/protocol-v1-validation/aggregate
```

Batch paths are deterministic by split, family, variant, seed, and controller ID. Failures are recorded and make the CLI exit nonzero; `--fail-fast` stops after the first. Existing completed output requires `--resume` or `--force`. Resume skips only when all four artifacts are present and parseable and scenario hash, method-config hash, and Git SHA match. `--allow-cross-commit-resume` explicitly relaxes only the Git check. Aggregation writes one completed-run row to `run-metrics.csv` and failures to `failures.csv`; unavailable values are empty CSV fields.

## Deferred work and interpretation

ORCA/RVO2 and Social Force adapters are deferred to Stage C. Parameter tuning, sensitivity sweeps, full test execution, statistical tests, plots, paper tables, and scientific conclusions are also deferred. No comparative claim has been established.

Full contact diagnostics and positional correction are global operations and have not been locality-optimized. Their existence is not evidence for an \(O(Nm)\) complete simulation step.
