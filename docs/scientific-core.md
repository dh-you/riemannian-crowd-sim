# Scientific simulation core

## Scope and separation

`src/core` is the exact, pure numerical implementation used by headless scientific runs. It has no Three.js, DOM, mesh, animation-loop, or rendering dependencies. `src/sim` remains the legacy interactive browser demonstrator: its behavior is intentionally unchanged, and its parameters and implementation must not be interpreted as the paper method.

The stable scientific controller identifier is `conditioned_riemannian_metric_v1`. Position, radius, interaction range, and wall thickness use meters; velocity and preferred speed use meters per second; time and time constants use seconds.

## Controller definition

For controlled agent $i$ and neighbor $j$, the relative position, distance, and radial unit vector are

\[
r_{ij}=p_j-p_i,\qquad d_{ij}=\lVert r_{ij}\rVert,\qquad \hat r_{ij}=r_{ij}/d_{ij}.
\]

When $d_{ij}<10^{-9}$ m, the radial direction is not well-defined. The implementation skips that neighbor's anisotropic metric contribution, increments `coincidentNeighborContributionsSkipped`, and leaves any overlap to the optional correction layer.

The radial-tangential tensor is

\[
A_{ij}=\lambda_t I+(\lambda_r-\lambda_t)\hat r_{ij}\hat r_{ij}^{\mathsf T}.
\]

It has radial eigenvalue `lambdaR` and tangential eigenvalue `lambdaT`. The controller validates `lambdaR > 0`, `lambdaT > 0`, `alpha >= 0`, and `sigma > 0`. Every agent radius and preferred speed must also be positive.

The compactly supported Wendland $C^2$ kernel is

\[
\phi(s)=\begin{cases}(1+4s)(1-s)^4,&0\leq s<1,\\0,&s\geq1.\end{cases}
\]

Negative or non-finite normalized distances are rejected.

The signed distance rate and closing gate are

\[
\dot d_{ij}=\hat r_{ij}^{\mathsf T}(v_j-v_i),\qquad
c_{ij}=\operatorname{smoothstep}_{[0,s_i]}(-\dot d_{ij}).
\]

Thus separating and co-moving neighbors have zero closing influence, while sufficiently fast approach saturates at one. Smoothstep is the clamped cubic $S(t)=3t^2-2t^3$.

Front/back visibility is defined only by the current goal direction, not current velocity:

\[
h_i=\frac{q_i-p_i}{\lVert q_i-p_i\rVert},\qquad
f_{ij}=\operatorname{smoothstep}_{[-1,1]}(h_i^{\mathsf T}\hat r_{ij}).
\]

Directly ahead, lateral, and directly behind map to 1, 0.5, and 0. There is no global rotational bias, velocity-heading convention, front-gate floor, or gate-width parameter in the scientific controller.

The effective metric is

\[
G_i=I+\sum_{j\ne i}\alpha\,\phi(d_{ij}/\sigma)c_{ij}f_{ij}A_{ij}.
\]

All contributions come from one immutable state snapshot. The deterministic spatial hash returns candidates in ascending agent-ID order, and contributions are accumulated in that order, independent of the input array order.

For the goal potential $\Phi_i(p)=\lVert p-q_i\rVert^2$, the gradient is $g_i=2(p_i-q_i)$. The implementation solves the symmetric $2\times2$ system

\[
G_i x_i=g_i
\]

with determinant, symmetry, positive-definiteness, and finite-value guards; it does not explicitly form an inverse. The target velocity is

\[
v_i^\star=-s_i\frac{x_i}{\sqrt{g_i^{\mathsf T}x_i}}.
\]

For every non-goal state, $\sqrt{(v_i^\star)^{\mathsf T}G_i v_i^\star}=s_i$. With $G_i=I$, the result points exactly at the goal with Euclidean magnitude $s_i$. Within `goalTolerance`, the controller target is zero.

## Time integration and synchronization

Velocity smoothing uses elapsed physical time:

\[
\eta=e^{-\Delta t/\tau_v},\qquad
v_i^{\mathrm{smooth}}=\eta v_i+(1-\eta)v_i^\star.
\]

For `velocityTimeConstant = 0`, $\eta=0$ and target tracking is immediate. An agent that begins a step inside the closed goal-tolerance disk is held stationary before correction: both target and smoothed velocity are zero, its pre-correction position equals its old position, and its intended displacement is zero regardless of residual incoming velocity.

For an agent that begins outside the goal disk, the nominal pre-correction position is $p_i+\Delta t\,v_i^{\mathrm{smooth}}$. If the segment from the old position to that proposal intersects the closed goal disk, a deterministic analytic segment-circle solve truncates motion at the first intersection. This prevents a fixed step from passing completely through the goal region. The diagnostic `smoothedVelocity` remains the nominal smoothed velocity, while `preCorrectionPosition` and `intendedDisplacement` describe the truncated motion actually applied before correction.

Every fixed step snapshots all agents, builds neighbors from that snapshot, computes all metrics and targets from it, computes all smoothed velocities and pre-correction positions, measures contacts, applies optional corrections, measures contacts again, and only then commits all ID-sorted states. Arrival is recomputed from each post-correction physical position and is not a permanent latch. Correction may therefore push an otherwise arrived agent outside the goal region; that agent becomes unarrived and resumes controller motion on the next step.

The realized velocity always records the actual final motion, including a truncated arrival step or correction displacement; it is not overwritten with zero when the agent reaches the goal:

\[
v_i^{\mathrm{realized}}=(p_i^{\mathrm{post}}-p_i^{\mathrm{old}})/\Delta t.
\]

Step indices are zero-based, while the reported step time is the post-step physical time. A horizon runs `horizonSeconds / dt` steps when that ratio is numerically integral; otherwise it runs the greatest whole number of fixed steps that does not exceed the horizon. `summary.json` reports the actual simulated duration.

## Optional correction layer

Correction is a numerical safeguard and is not part of the claimed collision-avoidance controller. It may be disabled and is measured separately.

Agent-agent correction uses fixed-count Jacobi passes. Overlapping pairs are sorted by `(minId, maxId)`, contribute equal-and-opposite displacements toward a minimum distance of `radius_i + radius_j + padding`, and are applied simultaneously. Exactly coincident agents receive a deterministic direction derived from their IDs; no randomness is used.

Walls are finite line segments with thickness. Closest-point projection enforces clearance

```text
agent.radius + wall.thickness / 2 + padding
```

Wall contributions in each pass are also accumulated before simultaneous application. An agent exactly on a wall centerline receives a deterministic normal derived from stable agent and wall IDs. Zero-length wall segments are rejected by scenario validation.

Because correction is applied after goal handling, it may displace an agent that was held inside its goal region. Post-correction arrival then reflects whether the final position remains inside that region.

Diagnostics report physical overlap and wall penetration without counting padding. Correction counts can therefore be nonzero when padding alone triggered a safeguard. Displacement totals are sums over agents of Euclidean displacement magnitudes applied by each correction layer. The safe correction ratio is

\[
C_{\mathrm{rel}}=D_{\mathrm{correction}}/(D_{\mathrm{intended}}+10^{-12}\text{ m}).
\]

No zero denominator or non-finite result is silently replaced.

## Scenario format

Scenarios are validated JSON objects with `schemaVersion: 1`, a name and integer seed, simulation settings, the exact controller ID and parameters, agents, and finite wall segments. See `experiments/scenarios/free-space.json` and `experiments/scenarios/pairwise-offset.json`.

Agent entries contain `id`, `radius`, `preferredSpeed`, `position`, `velocity`, and `goal`; optional `arrived` defaults to `false`. Wall entries contain a unique integer `id`, `start`, `end`, and nonnegative `thickness`. Agent IDs must be unique. Vectors must contain exactly two finite numbers. Malformed input, non-finite values, nonpositive timesteps, negative horizons, invalid radii or speeds, invalid parameters, duplicate IDs, invalid wall segments, and unsupported schema or controller IDs are rejected rather than repaired with defaults.

`simulation.recordingInterval` is an optional positive integer. It defaults to one (every step), and the CLI `--record-every N` flag overrides it.

## Running and outputs

Install, type-check/build, test, and run the smoke suite with:

```bash
npm ci
npm run build
npm test
npm run core:smoke
```

Run a scenario headlessly with:

```bash
npm run core:run -- --scenario experiments/scenarios/pairwise-offset.json --out results/pairwise-offset
```

The output directory contains:

- `manifest.json`: scenario/controller identity, exact parameters, timestep, horizon, seed, Node and OS metadata, Git SHA when available, timestamp, arguments, and recording interval.
- `trajectory.jsonl`: one object per recorded post-step state, with ID-sorted agents, position, realized and target velocities, arrival state, and pre/post correction totals.
- `summary.json`: step count and duration, arrival count/fraction, minimum raw clearance, overlap exposure in pair-seconds, penetration-depth exposure in meter-seconds, intended and correction displacement totals, correction ratio, finite-value status, and ID-sorted final states.

These are infrastructure diagnostics and preliminary run outputs, not final paper metrics or experimental claims. Generated `results/` content is ignored by Git.

Trajectory records are streamed incrementally through `trajectory.jsonl.tmp`; the runner does not retain the full trajectory in memory. After a successful simulation and metadata write, it closes the temporary file and atomically renames it to `trajectory.jsonl`. Failed runs remove temporary and finalized output artifacts when possible while preserving the original failure.

The controller uses local spatial queries, but full contact measurement and positional correction have not been optimized with the same locality. They are not a basis for an $O(Nm)$ full-step performance claim. Later performance experiments must time the controller, diagnostics, and correction layers separately unless the latter layers are also optimized.

## Deferred work

ORCA/RVO2, Social Force, parameter tuning, parameter sweeps, final experiments, paper figures and tables, and any comparative or performance claims are intentionally deferred to later stages.
