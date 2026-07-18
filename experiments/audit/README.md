# Stage D0 independent audit harness

This directory contains audit inputs and implementations that are intentionally
separate from the production experiment code. It does not tune methods or
produce paper comparisons.

The Python metric evaluator derives contacts, paths, arrival times, smoothness,
throughput, pairwise onset, and TTC from full physical engine-step records. It
does not import the production accumulator, diagnostics, corrections, or
geometry modules. The Python Riemannian reference implements the published
equations with the standard library only. The TypeScript snapshot evaluator is
the comparison side: it calls the production controller without reimplementing
its equations.

Generated evidence is written under `results/stage-d0-audit/` and is ignored by
Git. A machine-generated visual packet always remains `PENDING HUMAN REVIEW`.

Commands:

```bash
npm run audit:metrics
npm run audit:riemannian
npm run audit:gold
npm run audit:visuals
npm run audit:d0
```

After committing the audit harness, run `npm run audit:clean-clone`. That command
uses `git clone --no-local`, bootstraps both pinned baselines in the clone, and
compares a four-method physical run with this checkout.

The audit fails closed. A mismatch remains visible in its fixture, report, and
nonzero exit code; it must not be repaired by changing expected values or
loosening tolerances.
