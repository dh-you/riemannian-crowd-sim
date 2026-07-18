# Riemannian crowd simulation

This repository contains an interactive Three.js crowd-simulation demonstrator and a separate headless numerical core for reproducible experiments.

## Browser demonstrator

The existing code under `src/sim` and `src/tests` powers the legacy browser pages. Run it with:

```bash
npm run dev
```

## Scientific experiment core

The pure TypeScript implementation under `src/core` is the scientific controller intended for future EUMAS experiments. It is deliberately isolated from Three.js, the DOM, rendering, and the legacy browser behavior.

See [docs/scientific-core.md](docs/scientific-core.md) for the exact equations, sign conventions, scenario schema, diagnostics, output files, and commands.

```bash
npm test
npm run core:smoke
npm run core:run -- --scenario experiments/scenarios/pairwise-offset.json --out results/pairwise-offset
```
