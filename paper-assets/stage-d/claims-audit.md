# Stage D claims audit

Statuses describe the frozen evidence without forcing a favorable narrative. No p-values were produced.

## 1. Goal completion

- Claim: Goal completion
- Metric supporting it: Frozen-test success fraction
- Scenario set: frozen test
- Method/config hashes: conditioned_riemannian_metric_v1--45386d3d5316
- Point estimate: 0.277
- Confidence interval: [0.255, 0.298]
- Limitations: Completion does not establish behavioral realism.
- Status: **CONTRADICTED**

## 2. Raw pre-correction safety

- Claim: Raw pre-correction safety
- Metric supporting it: Overlap exposure and maximum penetration
- Scenario set: frozen test
- Method/config hashes: conditioned_riemannian_metric_v1--45386d3d5316
- Point estimate: 0.624
- Confidence interval: [0.610, 0.637]
- Limitations: Raw overlaps are preserved; post-correction safety is not substituted.
- Status: **PARTIALLY SUPPORTED**

## 3. Dependence on positional projection

- Claim: Dependence on positional projection
- Metric supporting it: Correction ratio
- Scenario set: frozen test
- Method/config hashes: conditioned_riemannian_metric_v1--45386d3d5316
- Point estimate: 0.830
- Confidence interval: [0.818, 0.923]
- Limitations: Native-none baselines have structurally zero correction ratio, not structurally zero collision exposure.
- Status: **PARTIALLY SUPPORTED**

## 4. Travel efficiency

- Claim: Travel efficiency
- Metric supporting it: Normalized travel time conditional on success and path ratio
- Scenario set: frozen test
- Method/config hashes: conditioned_riemannian_metric_v1--45386d3d5316
- Point estimate: 1.497
- Confidence interval: [1.476, 1.516]
- Limitations: Failed arrivals are not imputed.
- Status: **PARTIALLY SUPPORTED**

## 5. Motion smoothness

- Claim: Motion smoothness
- Metric supporting it: RMS acceleration and jerk
- Scenario set: frozen test
- Method/config hashes: conditioned_riemannian_metric_v1--45386d3d5316
- Point estimate: 2.792
- Confidence interval: [2.711, 2.836]
- Limitations: Simulation smoothness is not a calibrated human-motion measure.
- Status: **PARTIALLY SUPPORTED**

## 6. Pairwise anticipation

- Claim: Pairwise anticipation
- Metric supporting it: Avoidance-onset rate and TTC at onset
- Scenario set: frozen test
- Method/config hashes: conditioned_riemannian_metric_v1--45386d3d5316
- Point estimate: 0.525
- Confidence interval: [0.510, 0.540]
- Limitations: Deflection onset is behavioral evidence only under the preregistered five-degree definition.
- Status: **SUPPORTED**

## 7. Dense-flow and bottleneck behavior

- Claim: Dense-flow and bottleneck behavior
- Metric supporting it: Per-family safety, completion, and bottleneck throughput
- Scenario set: frozen test
- Method/config hashes: conditioned_riemannian_metric_v1--45386d3d5316
- Point estimate: 0.184
- Confidence interval: [0.162, 0.205]
- Limitations: Finite scenario families do not imply universal dense-flow behavior.
- Status: **PARTIALLY SUPPORTED**

## 8. Computational performance

- Claim: Computational performance
- Metric supporting it: End-to-end runtime benchmark
- Scenario set: as stated in metric
- Method/config hashes: see referenced data asset
- Point estimate: see referenced data asset
- Confidence interval: not applicable or see referenced data asset
- Limitations: Measured scaling is hardware- and implementation-specific; no asymptotic full-step claim is made.
- Status: **SUPPORTED**

## 9. Effect of anisotropy

- Claim: Effect of anisotropy
- Metric supporting it: Full versus isotropic holdout ablation
- Scenario set: as stated in metric
- Method/config hashes: see referenced data asset
- Point estimate: see referenced data asset
- Confidence interval: not applicable or see referenced data asset
- Limitations: Ablations use validation holdout only and are not test-tuned.
- Status: **SUPPORTED**

## 10. Effect of closing-speed conditioning

- Claim: Effect of closing-speed conditioning
- Metric supporting it: Full versus no_closing holdout ablation
- Scenario set: as stated in metric
- Method/config hashes: see referenced data asset
- Point estimate: see referenced data asset
- Confidence interval: not applicable or see referenced data asset
- Limitations: Ablation is mechanical and uses the frozen full parameters.
- Status: **SUPPORTED**

## 11. Effect of visibility conditioning

- Claim: Effect of visibility conditioning
- Metric supporting it: Full versus no_visibility holdout ablation
- Scenario set: as stated in metric
- Method/config hashes: see referenced data asset
- Point estimate: see referenced data asset
- Confidence interval: not applicable or see referenced data asset
- Limitations: Ablation is mechanical and uses the frozen full parameters.
- Status: **SUPPORTED**

## 12. Sensitivity to parameters

- Claim: Sensitivity to parameters
- Metric supporting it: Preregistered screening one-at-a-time candidates
- Scenario set: as stated in metric
- Method/config hashes: see referenced data asset
- Point estimate: see referenced data asset
- Confidence interval: not applicable or see referenced data asset
- Limitations: Only preregistered points are shown; no interpolation or test-driven extension.
- Status: **SUPPORTED**

## 13. Exact symmetric failure case

- Claim: Exact symmetric failure case
- Metric supporting it: D0 exact_symmetric_diagnostic
- Scenario set: as stated in metric
- Method/config hashes: see referenced data asset
- Point estimate: see referenced data asset
- Confidence interval: not applicable or see referenced data asset
- Limitations: The exact symmetric case exposes the no-global-bias limitation and is excluded from aggregate statistical claims.
- Status: **SUPPORTED**

## 14. Limits of behavioral-realism claims

- Claim: Limits of behavioral-realism claims
- Metric supporting it: No calibrated human trajectory dataset in Stage D
- Scenario set: as stated in metric
- Method/config hashes: see referenced data asset
- Point estimate: see referenced data asset
- Confidence interval: not applicable or see referenced data asset
- Limitations: PySocialForce is an implementation baseline; none of these results establish calibrated human realism.
- Status: **NOT RESOLVED**
