# Native baseline engines

The active paper baselines are ORCA/RVO2 and JuPedSim SocialForceModel. Their
locks are in `experiments/baselines/third-party-lock.json`. Neither engine uses
scientific-core smoothing or positional correction. They emit the common
engine-step schema, which records native commands, realized displacement,
contacts, and stable agent IDs for a common evaluator.

| Engine | Frozen dependency | License |
|---|---|---|
| ORCA/RVO2 | snape/RVO2 commit `b577921d2bc1281a6b721c2d4778f397d37da97d` | Apache-2.0 |
| JuPedSim | 1.4.2, CPython 3.12 Windows x64 wheel, SHA-256 locked | LGPL-3.0-or-later |

## Setup and verification

Use Windows x64 with Python 3.12, Git, MinGW-w64 G++, CMake, and Ninja on PATH.
`baselines:bootstrap` downloads pinned source/wheels and installs only the
dedicated local environment. `baselines:build` compiles Release ORCA without
OpenMP and writes hashes, compiler identity, package versions, and runner paths
to the build manifest. `baselines:verify` checks those identities and licenses.
Changed adapter sources require rebuilding the manifest. `test:baselines`
executes native integration tests; `baselines:smoke` exercises all four methods.

The original dependency and build manifests are preserved in
`paper/provenance/`. Their historical PySocialForce entries are evidence of the
original build environment, not an active dependency of this release.

## Mapping and numerical behavior

ORCA uses the scenario's positions, velocities, radii, speeds, and expanded
finite wall geometry. Its command is the selected RVO2 velocity. RVO2 uses
single precision; comparisons allow the existing 1e-6 float-boundary tolerance.

JuPedSim uses each agent's scenario radius and preferred speed, the common
protocol navigation target, and native geometry-aware wayfinding. Parameters
are bodyForce 120000, friction 240000, mass 80, reactionTime 0.5, agentScale
2000, obstacleScale 2000, and forceDistance 0.08. Each 1/60 s experiment step
contains two deterministic 1/120 s native steps. Both are included in timing.
The target is held across those substeps; output metrics sample the common
outer timestep. Coefficients are package defaults, not fitted human behavior.

Native trajectories are written before Node ingestion and consumed using
bounded line reads. State continuity and step indices are validated. The
scientific method and Goal+Projection retain the separately measured shared
projection; native engines have `correctionMode: native_none`.

## Historical implementation

PySocialForce execution code and setup were removed from the active tree.
They remain at scientific reference commit
`05241d55a90a7b873d0a403a30682e8577f8111d`. Its configuration schema and labels
remain readable so older records are interpretable, but the factory rejects
attempts to execute that archived engine. Its MIT notice is retained alongside
the RVO2 and JuPedSim notices. No new license for original project code is added.
