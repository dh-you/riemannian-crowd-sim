# Paper experiment protocol

The authoritative matrix is `experiments/lean/study.json`, unchanged from
scientific commit `05241d55a90a7b873d0a403a30682e8577f8111d`.
Run instructions are in [reproduction.md](reproduction.md).

## Methods and physical settings

Four methods receive identical generated initial states, walls, goals, 0.3 m
radii, preferred speeds within ±10% of 1.4 m/s, and completion rules.

- Ours: `conditioned_riemannian_metric_v1`, alpha 20, sigma 1.5 m, lambdaR 20,
  lambdaT 1, and smoothing time constant 0.04 s.
- Goal+Projection: Euclidean goal steering with the same smoothing and two
  positional-correction sweeps.
- ORCA/RVO2: 5 m neighbor range, 16 neighbors, 5 s agent and obstacle horizons.
- JuPedSim 1.4.2 SocialForceModel: package-default coefficients, native
  geometry-aware direct steering, two native half-steps per evaluation step.

The common timestep is 1/60 s. ORCA and JuPedSim retain native dynamics and
`native_none` correction semantics; they do not pass through the scientific
core's smoothing or projection.

## Scenarios and completion

| Scenario | Agents | Held-out seeds | Completion |
|---|---:|---|---|
| Perturbed head-on | 2 | 100–119 | Realized entry into goal disk |
| Perpendicular crossing | 2 | 100–119 | Realized entry into goal disk |
| Antipodal circle | 50 | 100–109 | Individual antipodal goal-disk entry |
| Bidirectional corridor | 120 | 100–109 | Correctly directed crossing of x=±17 |
| Six-wall bottleneck | 112 | 100–109 | Positive crossing of x=8 |

Pairwise scenes run for 30 s. Circle uses a horizon at least as long as
unobstructed ideal travel. Corridor agents continue toward far goals at x=±20.
Bottleneck agents first target [1.5,0] until strictly beyond x=1, then follow
lane-preserving goals [10,initialY]. These navigation targets and completion
lines are shared across methods. Completion is independent of legacy final
point-goal diagnostics.

The completion protocol is `completion-v2`; `completionSpecVersion: 1` is its
schema version. Segment intersection interpolates completion time within a
step. The implementation and edge-case tests are in `experiments/protocol/completion.ts`
and `tests/experiment/completionProtocol.test.ts`.

## Metrics and aggregation

- Completion is completed-agent fraction. Normalized completion time divides
  realized completion time by unobstructed ideal travel time and is conditional
  on completion; failed arrivals are not imputed.
- Raw overlap exposure is pre-correction agent-pair overlap time divided by
  agent-seconds. Maximum raw penetration is measured in metres before correction.
- RMS acceleration uses realized velocities at the shared output timestep and
  the completion-aware sampling implemented in `RunMetricsAccumulator`.
- Correction ratio divides correction displacement by intended displacement.
  Zero correction for native engines does not imply zero collision exposure.
- Table 1 reports medians across runs; CSVs also provide Q1/Q3, sample counts,
  units, and failure counts. Paired differences pair scenario seeds. No p-values
  or calibrated behavioral-realism conclusions are reported.

## Ablations, runtime, and diagnostics

Ablations use full, isotropic, no-closing, and no-visibility variants over
head-on, crossing, and corridor, seeds 200–204: 60 assignments. They preserve
the other frozen parameters. Runtime uses circle sizes 50, 100, and 200 with
seed 300, one warmup and three measured repetitions per method, serially.
The 20 visual audit runs use seed 0; separating and exact-symmetric diagnostics
add eight runs. Exact head-on symmetry remains a known limitation.

Scenario generation is deterministic. Configurations have hash-qualified
identities, manifests record implementation and baseline provenance, and full
audit trajectories retain pre-correction and post-correction states. Historical
Stage A–D outputs are separate studies and must not be substituted for this set.
