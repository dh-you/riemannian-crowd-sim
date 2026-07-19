# Stage D0 independent scientific audit guide

Stage D0 asks whether the experiment pipeline implements its documented
quantities and can be reproduced. It does not ask which method performs better.
The audit leaves all production scientific files unchanged and places any
instrumentation under `experiments/audit/`.

## Critical path walkthrough

```text
Scenario JSON
    ↓
Method config
    ↓
Engine adapter
    ↓
EngineStepRecord
    ↓
Full audit trajectory JSONL
    ↓
RunMetricsAccumulator
    ↓
run-metrics.json
    ↓
later CSV/statistics (not run in D0)
```

Scenario JSON contains physical positions, velocities, goals, radii, wall
segments, timestep, horizon, goal tolerance, and correction policy. Strict
production parsing validates it. The fairness audit hashes the unchanged source
bytes and verifies that every method receives the same hash. Inspect
`results/stage-d0-audit/fairness/report.json`.

The method config chooses one engine and its parameters. Canonical identity
version 2 is derived from validated semantics; the source-byte hash remains
separate provenance. The fairness audit checks both hashes, distinct method
keys, engine IDs, upstream commits, licenses, runner hashes, and build-manifest
hashes. Inspect each `audit-manifest.json` below the fairness results.

Each engine adapter owns its documented stepping semantics. Scientific Core
uses its controller, time-constant smoothing, and optional shared projection.
ORCA uses the RVO2-selected velocity, and PySocialForce uses its post-force
native velocity. Neither external engine receives Scientific Core smoothing or
projection. The audit-only sink observes the real adapter output without
changing it.

`EngineStepRecord` contains sorted stable IDs, position and velocity before the
step, pre/post-correction positions, native command velocity, realized velocity,
arrival state, and diagnostics. The Python evaluator rejects missing,
duplicate, or out-of-order steps and agents, initial-state mismatch,
discontinuity, inconsistent realized velocity, malformed JSON, and non-finite
values. Inspect `engine-steps.jsonl` in any audit run.

The production accumulator consumes every full step. Independently,
`evaluate_metrics.py` recomputes geometry and outcomes from the physical record
using only Python's standard library. `compare_metrics.py` compares every
supported metric with absolute and relative tolerances of `1e-9`, requires null
on both sides, records the first failure, and never adjusts tolerances. Inspect
`results/stage-d0-audit/metrics/report.json` and the per-run comparisons.

Later aggregation and statistics are deliberately outside D0. Stage D must not
start unless the D0 readiness gate and human review are satisfied.

## Hand-calculated synthetic fixtures

### Single linear arrival

The timestep is one second. A pedestrian starts at `(0,0)` with zero velocity,
has goal `(2,0)`, and prefers `1 m/s`. The two final positions are `(1,0)` and
`(2,0)` at times one and two.

- First arrival time: `2 s`.
- Ideal travel time: `2 m / 1 m/s = 2 s`.
- Normalized travel time: `2 / 2 = 1`.
- Realized path length: `1 m + 1 m = 2 m`.
- Path ratio: `2 / 2 = 1`.
- Acceleration samples: `(1,0)` and `(0,0) m/s²`.
- RMS acceleration: `sqrt((1² + 0²)/2) = sqrt(1/2)`.
- Jerk samples: `(-1,0) m/s³`.
- RMS jerk: `1 m/s³`.
- Throughput: `1 arrival / 2 s = 1/2 s⁻¹`.
- Correction displacement: `0 m`.

The numbers are committed before production evaluation in
`experiments/audit/synthetic/single-linear-expected.json`.

### Pairwise contact and onset

At the physical pre-correction state, center separation is `0.8 m` and each
radius is `0.5 m`, so clearance is `0.8 - 1.0 = -0.2 m`. One overlapping pair
for `dt=0.5 s` contributes `0.5 pair-seconds`. After correction the center
separation is exactly `1.0 m`, so physical clearance and penetration are zero.
The first command is deflected by exactly ten degrees, above the five-degree
onset threshold.

For the committed two-agent fixture, the initial relative center position is
`(2,0)`, relative velocity is `(-2,0)`, and the combined physical radius is
`1.0 m`; therefore the production-defined circular TTC is
`(2 - 1)/2 = 0.5 s`.

The D0 specification also requests the analytical case `r=(2,0)`, `v=(-2,0)`,
and combined radius `R=0.5 m`, whose TTC is `(2 - 0.5)/2 = 0.75 s`. That case is
covered independently in `self_test.py`. It cannot simultaneously be the same
physical two-agent state as two `0.5 m` radii and `0.8 m` center separation;
those radii have combined radius `1.0 m`. The audit records both calculations
instead of silently conflating them.

## Independent Riemannian reference

The Python reference directly implements:

```text
r_ij = p_j - p_i
d_ij = |r_ij|
r_hat_ij = r_ij / d_ij

A_ij = lambda_t I + (lambda_r - lambda_t) r_hat_ij r_hat_ij^T
phi(s) = (1 + 4s)(1-s)^4, 0 <= s < 1; otherwise 0
d_dot_ij = r_hat_ij^T (v_j - v_i)
c_ij = smoothstep_[0,s_i](-d_dot_ij)
h_i = (q_i-p_i)/|q_i-p_i|
f_ij = smoothstep_[-1,1](h_i^T r_hat_ij)
G_i = I + sum_j alpha phi(d_ij/sigma)c_ij f_ij A_ij
G_i x_i = 2(p_i-q_i)
v_i* = -s_i x_i / sqrt(g_i^T x_i)
```

It has no global rotational bias. The committed fixture contains seven named
edge/geometry cases plus 100 deterministic random valid snapshots. The
production side calls `RiemannianController`; the Python side shares no
repository math. Inspect
`results/stage-d0-audit/riemannian/comparison.json`.

## Gold scenarios and visual evidence

The gold suite covers free space, start-at-goal, separating pairwise motion,
exact symmetric head-on motion, Goal+Projection head-on motion, disabled
correction, and a finite thick wall. Expectations are written in plain language
in `experiments/audit/scenarios/expectations.json`.

SVGs show walls at physical thickness, start and goal markers, complete paths,
closest pre/post-correction circles, and avoidance-onset markers. They are aids
for review, not automatic evidence of plausible behavior. Use
`results/stage-d0-audit/visual-checklist.md` and create
`human-visual-review.json` yourself only after completing the checklist. The
audit must never approve that file.

## Resolved D0 path-semantics finding

The original D0 run found that the ORCA start-at-goal fixture maps exact scenario
coordinate `x=0.02` to RVO2's float32 coordinate `x=0.0199999996`. Its emitted
native step has zero displacement, but the old accumulator compared the mapped
position with the scenario coordinate and counted the `4e-10 m` representation
change as travel.

Stage C.2 clarified the uniform physical definition. For every engine and every
step through first arrival, path contributes exactly
`|postCorrectionPosition - positionBefore|` from that same emitted step. Initial
conversion into a native representation is not motion. A stationary mapped
step now contributes exactly zero without a clamp, tolerance, or ORCA special
case. A real mapped displacement still contributes its full length, and shared
positional correction remains included because the final post-correction
position is the realized physical position.

## Clean-clone provenance comparison

Each checkout's run manifest must match the SHA-256 of its own build manifest
and runner, and the two checkouts must match on stable source, lock, upstream,
toolchain, Python-package, method, and engine identity. Raw build-manifest hashes
are recorded but are not compared across checkouts because the manifest
intentionally contains its execution timestamp and absolute paths. Likewise, a
native Windows executable may carry a linker timestamp even when the stable
build identity and byte-identical trajectory agree. These location/time-specific
hashes remain locally verified and visible in the comparison report rather than
being treated as portable identities.

## What this audit proves—and what it does not prove

Agreement shows that two separately implemented calculations give the same
results for committed fixtures and emitted physical trajectories. Provenance
and clean-clone checks show whether those results can be reconstructed without
hidden local source or build state. Gold cases make important semantics visible.

The audit does not prove calibrated human realism, optimal baseline parameters,
universal collision avoidance, superiority, asymptotic performance, or final
paper claims. A visual review is still subjective evidence, and a finite fixture
set cannot prove correctness for every possible state.

## Questions Derek should be able to answer before Stage D

1. What does pre-correction agent clearance measure, and why is wall clearance separate?
2. Why can Goal+Projection look collision-free after projection despite a raw overlap?
3. What is the difference between command velocity and realized velocity for each engine?
4. Which methods use shared positional projection, and which use `native_none`?
5. How is first arrival defined and why are samples after it excluded?
6. Why are validation and test seeds separate, and why must the test split remain unopened before freezing?
7. What quantity is normalized in normalized travel time, and why is it conditional on arrival?
8. How does solving with the effective Riemannian metric redirect the goal gradient?
9. Which native semantics and pinned revisions do the ORCA and PySocialForce adapters preserve?
10. Why do pre- and post-correction safety answer different scientific questions?
11. What does the exact symmetric diagnostic reveal about the absence of a global turning bias?
12. Which claims remain unsupported before a valid Stage D study?

## Commands

```bash
npm run audit:metrics
npm run audit:riemannian
npm run audit:gold
npm run audit:visuals
npm run audit:d0
npm run audit:clean-clone
```

Any nonzero audit exit must be investigated from the first failure in the
machine-readable report. Expected values and tolerances are not repair knobs.
