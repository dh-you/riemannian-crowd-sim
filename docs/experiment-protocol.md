# Deterministic experiment protocol

## Architecture and scope

Stages B and C separate five concerns that must remain independently auditable:

1. An experiment scenario describes only the shared physical problem: agents, finite walls, units, fixed timestep, horizon, goal tolerance, and correction settings.
2. A method configuration selects an engine and its strictly validated native parameters.
3. `ScientificCoreEngine` wraps the two `MotionController` implementations and supplies the shared protocol target to `SimulatorCore`; ORCA and PySocialForce use separate external engine adapters that preserve native dynamics.
4. Every engine emits the versioned common `EngineStepRecord` physical contract.
5. `RunMetricsAccumulator` consumes every completed engine step online, independently of trajectory recording frequency.

The same scenario JSON is passed unchanged to every method. This prevents method-specific configuration from changing initial states or physical settings and lets manifests verify shared input through the same scenario SHA-256.

The Stage A `schemaVersion: 1` format and `core:run` remain supported without reinterpretation. The experiment protocol is a separate schema.

## Methods and configuration

Scientific Core configs retain `methodConfigVersion: 1`; native baseline configs use version 2 and include an explicit engine ID. Stable machine IDs and display labels are:

| Machine ID | Paper-facing label |
| --- | --- |
| `conditioned_riemannian_metric_v1` | Conditioned Riemannian |
| `euclidean_goal_steering_v1` | Goal+Projection |
| `orca_rvo2_v1` | ORCA/RVO2 |
| `social_force_pysocialforce_v1` | PySocialForce |

The Conditioned Riemannian implementation retains the Stage A equations and numerical operations documented in [scientific-core.md](scientific-core.md). The controller refactor delegates the same metric construction and inverse-metric target calculation through a common interface; it does not change goal-direction visibility, signed closing, Wendland weighting, tensor construction, solve-based steering, normalization, or ID-ordered accumulation.

For Goal+Projection, an agent outside the goal tolerance receives

\[
v_i^\star=s_i\frac{q_i^{\mathrm{nav}}-p_i}{\lVert q_i^{\mathrm{nav}}-p_i\rVert},
\]

where (q_i^{\mathrm{nav}}) is the shared current protocol target. An agent inside its final point-goal disk receives zero. It ignores neighbors, has interaction radius zero, and has no interaction parameters or lateral bias. “Projection” refers only to the optional shared positional correction layer; correction is not part of this controller.

The committed configs in `experiments/methods/` are provisional infrastructure defaults. They are not tuned or selected paper parameters.

Every exact method-config file also has a stable run identity:

```text
methodKey = <method-id>--<first-12-hex-characters-of-canonical-SHA-256>
```

Method identity version 2 parses and strictly validates the source, reconstructs a documented field order, sorts parameter keys lexicographically, serializes compact JSON with one trailing LF, and hashes those canonical UTF-8 bytes. Semantically identical whitespace, line endings, and parameter-key ordering therefore have the same key, while a value change does not. Manifests retain both `methodConfigCanonicalSha256` and the provenance-only `methodConfigSourceSha256`. Output directories, metrics, batch identity, and resume use the canonical hash. The aggregate CSV exposes applicable Scientific Core, ORCA, and Social Force parameters; unavailable values are empty fields.

## Experiment scenario version 2

An `experimentScenarioVersion: 2` document contains:

- `name`, `family`, `variant`, `split`, and an integer `seed`;
- `simulation.dt`, `horizonSeconds`, `goalTolerance`, and correction configuration;
- agents with unique safe-integer IDs, positive radius and preferred speed, and finite 2D position, velocity, and goal;
- finite, nondegenerate wall segments with unique safe-integer IDs and nonnegative thickness;
- a strictly validated completion specification and one ideal completion distance for every agent;
- a shared protocol-navigation specification used by every method;
- explicit distance unit `m` and time unit `s`.

It contains no controller parameters, smoothing time constant, or method label. Parsing is strict: unknown fields, unsupported versions, non-finite values, malformed vectors, invalid IDs, duplicate or missing per-agent rules, invalid physical quantities, and degenerate walls are rejected. Historical version-1 fixtures remain readable and are interpreted as point-goal navigation with goal-disk completion; generated study scenarios use version 2.

Completion is one of `goal_disk`, one shared `directional_line`, or `per_agent_directional_line`. A directional line records an axis (`x` or `y`), finite threshold, and positive or negative crossing direction. Completion is irreversible and is evaluated on the realized segment from the previous committed position to the current post-correction position. Goal-disk entry uses the first analytic segment-disk intersection. A serialized endpoint no farther outside the boundary than the common scaled position tolerance, (2\times10^{-7}\max(1\ \mathrm m,|p|,|q|,\epsilon_q)), is treated as the analytic boundary endpoint; this accommodates the pinned float32 ORCA representation without using `arrived`. A line requires a strict crossing from the incomplete side to the completed side in the specified direction; touching or a wrong-direction crossing does not count and receives no tolerance expansion. The event time is linearly interpolated within the timestep.

`AgentState.arrived` retains its original point-goal meaning and controller stopping behavior. Paper-facing completion is tracked independently. The protocol also records `legacyFirstPointGoalArrivalTime`, minimum and final point-goal distance, pre- and post-correction point-goal entries, and entries for which correction moved the endpoint back outside the point-goal disk.

The shared navigation resolver returns the assigned point goal except for the bottleneck. Before an agent is strictly beyond `x=1`, every method targets the free-space waypoint `[1.5,0]`; after that it targets the agent's individual final goal `[10, initialY]`. The waypoint, switch rule, and current target are carried through the common protocol, and native output is rejected if its reported target differs from the shared resolver.

## Deterministic generation

`DeterministicRandom` is a repository-owned Mulberry32 generator. Its state and output are unsigned 32-bit integers; `nextFloat()` is exactly the output integer divided by \(2^{32}\), producing a value in \([0,1)\). No generator uses `Math.random()`, time, the OS, or a platform-specific entropy source. A committed integer golden sequence prevents silent algorithm changes.

Generator version `protocol_v1` writes ID-sorted, stable pretty JSON with no timestamp. Each scenario is checked for initial agent-agent and agent-wall physical overlap with a \(10^{-10}\) m numerical tolerance. `suite-manifest.json` records identity, population, generator and suite versions, scenario SHA-256, suite-definition hash, and Git SHA when available. Regenerating a suite produces byte-identical scenario files.

Generation clears an existing output directory before writing, but only strict descendants of `<repository>/experiments/generated/` or `<repository>/experiments/tmp/` are accepted. The roots themselves, other repository paths, paths outside the repository, and symbolic-link traversal are rejected before recursive deletion.

Defaults are metric-scale navigation fixtures, not human calibration: radius 0.3 m, preferred speed centered at 1.4 m/s with approximately ±10% variation, timestep 1/60 s, and correction padding 0.001 m.

### Scenario families

- Pairwise: the active paper study uses seeded `head_on` and perpendicular `crossing` encounters with 30-second horizons. Historical `overtaking` and `separating` generators remain available. The separate `exact_symmetric_diagnostic` exposes the controller's left/right symmetry limitation and is excluded from statistical splits.
- Circle antipodal: near-even circular placement with antipodal goals and small angular/speed perturbations. Validation uses 50 agents and test uses 100. Its horizon is at least 30 seconds and is extended deterministically when the longest unobstructed ideal travel time is greater.
- Bidirectional flow: two equal counter-moving populations in a finite-wall corridor. Assigned navigation goals remain at `x=+20` and `x=-20`; paper completion is the first positive crossing of `x=+17` for right-moving agents or negative crossing of `x=-17` for left-moving agents. Completed agents remain active toward their far goals.
- Bottleneck: one population approaches the central 2.4 m opening in a closed six-wall chamber. Every agent first targets `[1.5,0]`, switches to its lane-preserving final goal `[10, initialY]` beyond `x=1`, and completes on the first positive crossing of `x=8`.

### Seed split

Validation pairwise cases use seeds 0–9; circle, bidirectional, and bottleneck use seeds 0–4. Test pairwise cases use seeds 1000–1049; circle, bidirectional, and bottleneck use seeds 1000–1029. These sets are disjoint. The complete definition contains 346 scenarios, including one seed-independent diagnostic, but Stage B validation does not execute the full test split.

Committed fixtures under `experiments/fixtures/protocol-v1/` include the exact diagnostic and seed 0 validation output for every family.

## Online metrics

Metrics consume every common engine step, even when `trajectory.jsonl` is subsampled.

`firstCompletionTime` is the interpolated first realized-trajectory completion event. Success is the fraction of agents with such an event, and throughput is completed agents divided by simulated seconds. These metrics do not use `AgentState.arrived` as their source.

For completed agent \(i\), normalized completion time is

\[
T_i^{\mathrm{norm}}=\frac{T_i^{\mathrm{completion}}}{D_i^{\mathrm{ideal}}/s_i}.
\]

For goal-disk scenarios, \(D_i^{\mathrm{ideal}}=\max(0,\lVert q_i-p_i^0\rVert-\epsilon_q)\). For corridor agents it is the absolute initial x-distance to the assigned exit line. For bottleneck agents it is the initial Euclidean distance to `[1.5,0]` plus `8-1.5=6.5` m. An agent that does not complete has a null normalized completion time.

The legacy path-efficiency diagnostic remains point-goal based and is not silently redefined by directional completion. Its realized path length stops at the first point-goal entry and is accumulated from each emitted physical step:

\[
L_i^{\mathrm{realized}}=\sum_{k\leq k_i^{\mathrm{first\ point\ goal\ entry}}}
\left\lVert p_{i,\mathrm{post}}^{(k)}-p_{i,\mathrm{before}}^{(k)}\right\rVert.
\]

The before and final positions come from the same `EngineStepRecord`. Therefore initial conversion into a native engine's representation is not physical travel, while positional correction remains part of realized displacement. No engine-specific clamp or tolerance is used. Per-agent values plus mean and median are written; unavailable aggregates are `null`.

Agent-agent and agent-wall safety are never combined in experiment metrics. The main safety fields are `minimumPreCorrectionAgentClearance`, agent overlap pair-seconds, and maximum pre/post agent penetration. Wall clearance and maximum pre/post wall penetration are reported in separate fields. Physical overlap and penetration exclude correction padding. The legacy core diagnostics retain combined aliases for Stage A compatibility, but experiment metrics and CSV columns do not use those aliases.

Correction metrics sum intended, agent-correction, wall-correction, and total-correction displacement over all agents and steps. The ratio is

\[
D_{\mathrm{correction}}/(D_{\mathrm{intended}}+10^{-12}\ \mathrm m).
\]

Smoothness uses realized velocity and physical timestep. The initial scenario velocity precedes the first acceleration sample. Each active agent-step contributes one squared vector magnitude; RMS acceleration is the square root of the sum divided by the number of acceleration vector samples. Jerk is aggregated identically over consecutive acceleration samples. To preserve the established diagnostic, an agent contributes no later samples after its first point-goal entry. A missing denominator yields `null`.

Throughput is paper-facing completions divided by simulated seconds; it is `null` at zero duration.

### Pairwise anticipation

The unobstructed direction is \(u_i^0=(q_i-p_i)/\lVert q_i-p_i\rVert\). Avoidance onset is the first step-start time when

\[
\delta_i=\cos^{-1}\!\left(\frac{v_i^{\mathrm{command}}\cdot u_i^0}{\lVert v_i^{\mathrm{command}}\rVert}\right)>5^\circ.
\]

Zero command velocity or an undefined goal direction does not declare onset. `commandVelocity` is the controller target before Scientific Core smoothing, the selected integration velocity for ORCA, and the native post-force/pre-position velocity for PySocialForce. These are native behavioral commands, not the same mathematical object. At onset, TTC solves \(\lVert r+tv\rVert^2=R^2\) and stores the earliest nonnegative finite root. Separating, stationary, invalid, or non-collision trajectories yield `null`; already overlapping circles yield zero.

Pairwise separation reports four explicitly qualified values: minimum pre-correction center distance, minimum pre-correction physical clearance, minimum post-correction center distance, and minimum post-correction physical clearance. “Center distance” is the raw center-to-center distance; “physical clearance” subtracts both radii. The pre-correction values measure controller output before the numerical safeguard, so correction cannot hide a controller collision.

## Running experiments

Generate the deterministic protocol:

```bash
npm run exp:generate -- --suite experiments/suites/protocol-v1.json --out experiments/generated/protocol-v1
```

Run one scenario with any method (external methods require bootstrap and build first):

```bash
npm run exp:run -- --scenario experiments/generated/protocol-v1/validation/pairwise/head_on/seed-0.json --method experiments/methods/riemannian-default.json --out results/stage-c-riemannian-example
npm run exp:run -- --scenario experiments/generated/protocol-v1/validation/pairwise/head_on/seed-0.json --method experiments/methods/goal-projection.json --out results/stage-c-goal-example
npm run exp:run -- --scenario experiments/generated/protocol-v1/validation/pairwise/head_on/seed-0.json --method experiments/methods/orca-default.json --out results/stage-c-orca-example
npm run exp:run -- --scenario experiments/generated/protocol-v1/validation/pairwise/head_on/seed-0.json --method experiments/methods/social-force-default.json --out results/stage-c-social-force-example
```

The runner writes atomic `manifest.json`, `trajectory.jsonl`, `summary.json`, and `run-metrics.json`. The manifest records engine, adapter, correction and command semantics, canonical/source method identity, exact method settings, scenario identity, platform, Git SHA, arguments, and execution time. External runs additionally require the pinned upstream, license, runner, build-manifest, and lock-file provenance. Native JSONL and resume validation use a bounded line reader rather than loading complete trajectories. Native IDs must already be unique, ascending, and identical to the scenario, while step-zero and inter-step positions must be continuous; inconsistent output is rejected rather than sorted or repaired. Trajectory records are engine-independent and ID-sorted. `--record-every N` changes trajectory density but not metrics.

Run the CI-sized cross-method smoke suite:

```bash
npm run exp:smoke
npm run baselines:bootstrap
npm run baselines:build
npm run baselines:verify
npm run baselines:smoke
```

Run a split sequentially and aggregate it:

```bash
npm run exp:batch -- --suite experiments/generated/protocol-v1/suite-manifest.json --methods experiments/methods/riemannian-default.json,experiments/methods/goal-projection.json,experiments/methods/orca-default.json,experiments/methods/social-force-default.json --split validation --out results/protocol-v1-validation
npm run exp:aggregate -- --input results/protocol-v1-validation --out results/protocol-v1-validation/aggregate
```

Batch manifest version 4 paths are deterministic by split, family, variant, seed, and canonical method key. Failures, including external-runner stderr excerpts, are recorded and make the CLI exit nonzero; `--fail-fast` stops after the first. Existing completed output requires `--resume` or `--force`. Resume verifies all artifacts plus scenario, canonical method identity, method-key, engine, adapter, lock, upstream, runner, build-manifest, and repository identities. `--allow-cross-commit-resume` relaxes only the repository Git SHA check. Aggregation also accepts existing version-3 batch manifests. It writes one completed-run row to `run-metrics.csv` and failures to `failures.csv`; unavailable values are empty CSV fields.

## Deferred work and interpretation

ORCA/RVO2 and PySocialForce are integrated above `MotionController`, because that target-velocity interface is intentionally specific to the shared scientific core. ORCA is not passed through the core's exponential smoothing, and Social Force retains its acceleration and relaxation dynamics. The boundary is:

```text
ExperimentScenario
        |
ExperimentEngine
  |-- ScientificCoreEngine
  |-- OrcaRvo2Engine
  `-- PySocialForceEngine
        |
EngineStepRecord + RunMetricsAccumulator
```

Each adapter owns its native stepping semantics while emitting the same physical state and diagnostics needed by the common evaluator. See [baseline-engines.md](baseline-engines.md) for exact pins, mappings, build steps, and limitations. Parameter tuning, sensitivity sweeps, frozen test execution, statistical tests, plots, paper tables, and scientific conclusions remain deferred. No comparative claim has been established.

Full contact diagnostics and positional correction are global operations and have not been locality-optimized. Their existence is not evidence for an \(O(Nm)\) complete simulation step.
