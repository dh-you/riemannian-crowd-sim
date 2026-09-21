# Scientific simulation core

`src/core/` is the pure numerical implementation used by the headless scientific runners. It has no Three.js, DOM, rendering, or native-code dependencies. The browser demo under `src/demo/` remains a separate interactive implementation.

The two supported controllers are:

- `conditioned_riemannian_metric_v1`: the agent-induced Riemannian controller.
- `euclidean_goal_steering_v1`: direct Euclidean goal steering used as the lightweight comparison method.

Positions and radii are in metres, velocities in metres per second, and time values in seconds.

## Riemannian controller

For controlled agent $i$ and neighbor $j$,

\[
r_{ij}=p_j-p_i,\qquad d_{ij}=\lVert r_{ij}\rVert,\qquad \hat r_{ij}=r_{ij}/d_{ij}.
\]

The anisotropic radial/tangential tensor is

\[
A_{ij}=\lambda_t I+(\lambda_r-\lambda_t)\hat r_{ij}\hat r_{ij}^{\mathsf T}.
\]

Neighbor influence is compactly supported with the Wendland $C^2$ kernel

\[
\phi(s)=\begin{cases}(1+4s)(1-s)^4,&0\leq s<1,\\0,&s\geq1.\end{cases}
\]

and modulated by closing-speed and front/back visibility gates. The resulting metric is

\[
G_i=I+\sum_{j\ne i}\alpha\,\phi(d_{ij}/\sigma)c_{ij}f_{ij}A_{ij}.
\]

For the goal potential $\Phi_i(p)=\lVert p-q_i\rVert^2$ with gradient $g_i=2(p_i-q_i)$, the implementation solves

\[
G_i x_i=g_i
\]

without explicitly forming an inverse, then commands

\[
v_i^\star=-s_i\frac{x_i}{\sqrt{g_i^{\mathsf T}x_i}}.
\]

The solver checks symmetry, positive-definiteness, determinant magnitude, and finite values. Coincident neighbors whose radial direction is undefined are skipped in the anisotropic contribution and recorded in diagnostics.

## Time integration

Velocity smoothing uses elapsed physical time:

\[
\eta=e^{-\Delta t/\tau_v},\qquad
v_i^{\mathrm{smooth}}=\eta v_i+(1-\eta)v_i^\star.
\]

All agents are stepped synchronously from an immutable state snapshot. Neighbor candidates are processed deterministically in ascending agent-ID order. Goal entry is handled with a deterministic segment-circle intersection so a fixed timestep cannot pass completely through the goal region.

Realized velocity is always computed from the final physical displacement,

\[
v_i^{\mathrm{realized}}=(p_i^{\mathrm{post}}-p_i^{\mathrm{old}})/\Delta t.
\]

## Optional correction layer

Position correction is a numerical safeguard, not part of the claimed avoidance controller. Agent-agent overlap correction uses fixed-count Jacobi passes with deterministic pair ordering. Finite thick wall segments use closest-point projection with agent radius, half wall thickness, and configured padding.

Diagnostics separately report pre/post-correction overlap, wall contact, penetration, intended displacement, correction displacement, and correction dependence. Correction can be disabled.

## Determinism and validation

The core rejects non-finite values, invalid radii or speeds, malformed vectors, unsupported controller IDs, invalid wall segments, and invalid controller parameters rather than repairing them with defaults. Simulation order does not depend on input agent-array order.

Core unit tests live in `tests/core/` and cover controller behavior, corrections, determinism, formulation, runner behavior, simulation, and validation.

## Running the core

Install dependencies and run the scientific checks with:

```sh
npm ci
npm test
npm run build
npm run core:smoke
```

Run a standalone scenario with:

```sh
npm run core:run -- --scenario experiments/scenarios/pairwise-offset.json --out results/pairwise-offset
```

The runner writes a manifest, streamed trajectory JSONL, and summary diagnostics under the selected output directory. Generated `results/` content is not tracked.

For the generic generate → run → aggregate experiment layer, see [`experiment-protocol.md`](experiment-protocol.md). The publication-era evidence and external baselines are archived in the `paper-eumas-2026-v1.0` release/tag rather than current `main`.
