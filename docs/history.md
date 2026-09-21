# Historical implementations

The paper's experiment source is commit
`05241d55a90a7b873d0a403a30682e8577f8111d`, preserved by tag
`paper-eumas-2026-scientific-reference` and branch `camera-ready-jupedsim-v2`.
The publication release reorganizes the demo and removes inactive setup without
changing the scientific equations, scenario generation, metrics, or frozen study.
Release metadata distinguishes the cleanup commit from the experiment commit.

`scientific-results-stage-d` contains an earlier four-method study using
PySocialForce; its results differ from the published JuPedSim study. The
`camera-ready-clean` and `camera-ready-sfm-radius` branches also preserve
intermediate experiments. These historical branches and local worktrees are
not deleted or rewritten by the publication cleanup.

To inspect historical code, use a separate checkout of the reference commit.
Do not replace published evidence with Stage D or intermediate summaries.
Historical absolute paths in provenance are retained verbatim; distribution
inventories map the portable archive instead of rewriting those records.
