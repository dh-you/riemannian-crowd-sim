# Agent-Induced Riemannian Metric Fields for Crowd Simulation

Accepted as a demonstrator paper at EUMAS 2026.

This repository contains an interactive Three.js crowd-simulation demonstrator and a separate headless numerical core for reproducible experiments.

## Browser demonstrator

The existing code under `src/sim` and `src/tests` powers the legacy browser pages. Run it with:

```bash
npm run dev
```

## Scientific experiment core

The pure TypeScript implementation under `src/core` contains the scientific controllers and shared simulator intended for future EUMAS experiments. It is deliberately isolated from Three.js, the DOM, rendering, and the legacy browser behavior.

See [docs/scientific-core.md](docs/scientific-core.md) for the exact equations, sign conventions, scenario schema, diagnostics, output files, and commands.

```bash
npm test
npm run core:smoke
npm run core:run -- --scenario experiments/scenarios/pairwise-offset.json --out results/pairwise-offset
```

## Deterministic experiment protocol

Stage B adds controller-independent physical scenarios, versioned method configs, deterministic scenario generators, the Goal+Projection negative control, shared online metrics, sequential batch execution, and CSV aggregation. Stage B.1 separates agent/wall safety outputs, records pairwise separation before and after correction, and gives every exact method config a hash-qualified run key. The same scenario JSON is reused unchanged across methods.

See [docs/experiment-protocol.md](docs/experiment-protocol.md) for the protocol versions, scenario splits, exact metric definitions, reproducibility guarantees, and experiment commands.

```bash
npm run exp:generate -- --suite experiments/suites/protocol-v1.json --out experiments/generated/protocol-v1
npm run exp:smoke
```

## Baseline engines

Stage C adds engine-level adapters for pinned C++ RVO2/ORCA and PySocialForce while preserving each engine's native dynamics. They share the same controller-independent scenarios and common evaluator, but they do not pass through `MotionController`, Scientific Core smoothing, or Scientific Core positional correction.

See [docs/baseline-engines.md](docs/baseline-engines.md) for exact upstream commits, licenses, the locked patch, parameter/state/wall mappings, common engine-step schema, provenance, and limitations.

```bash
npm run baselines:bootstrap
npm run baselines:build
npm run baselines:verify
npm run test:baselines
npm run baselines:smoke
```

The baseline defaults are provisional infrastructure settings. No tuning or comparative conclusion is included.
