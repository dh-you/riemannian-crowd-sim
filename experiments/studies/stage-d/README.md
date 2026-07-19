# Stage D preregistered study

Stage D separates validation-only configuration selection, configuration
freezing, one-time frozen test execution, and statistical/paper-asset analysis.
The locked inputs are under `plan/`; raw runs and phase manifests are written to
the ignored `results/stage-d/` tree.

The headline methods are Conditioned Riemannian, Goal+Projection, ORCA/RVO2,
and PySocialForce. Goal+Projection is a negative control whose smoothing time
constant is mechanically inherited from the selected Riemannian configuration.

The selection hierarchy uses equally weighted scenario families and raw
pre-correction safety. It does not use test results. Test comparisons are paired
by exact scenario identity and use a deterministic stratified percentile
bootstrap with seed 20260718 and 10,000 replicates. The independent unit is a
scenario instance, not an agent or timestep.

Commands, in order:

```bash
npm run study:d:plan
npm run study:d:candidates
npm run study:d:screen
npm run study:d:validation
npm run study:d:select
npm run study:d:ablations
npm run study:d:freeze
# commit exactly: Freeze Stage D method configurations
npm run study:d:test -- --jobs 1 --fail-fast
npm run study:d:merge
npm run study:d:runtime
npm run study:d:analyze
npm run study:d:paper
npm run study:d:verify
```

The frozen test runner supports deterministic `--shard-index`, `--shard-count`,
`--jobs`, `--resume`, and `--fail-fast` options. A merge rejects missing or
duplicate assignments. Test execution refuses to start unless HEAD is the clean
freeze commit and every plan, scenario, method, upstream, runner, and build
identity matches.

The Riemannian ablations are experiment-only and do not alter the stable
`conditioned_riemannian_metric_v1` controller. Full mode is regression-tested
against every D0 snapshot and exact SimulatorCore steps. Ablations and
sensitivity use validation data only.

Paper assets under `paper-assets/stage-d/` preserve raw-versus-corrected safety,
conditional travel-time semantics, native external-engine behavior, exact
symmetric limitations, and the absence of calibrated human-realism evidence.
