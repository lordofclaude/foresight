# Foresight baseline evaluation

> **PIPELINE-DEMONSTRATION** — Performance claims refused: 2 holdout fixtures is below the minimum of 20.

This report is reproducible pipeline output. It is not evidence that Foresight has predictive edge when the minimum sample threshold is not met.

## Dataset and split

- Checked-in tapes discovered: 4
- Eligible finalized fixtures: 4
- Train fixtures: 18222446, 18237038
- Holdout fixtures: 18241006, 18257865
- Minimum holdout fixtures for a performance claim: 20
- Leakage control: fixtures are ordered by start time and assigned whole to train or holdout.

## Descriptive holdout metrics

| Metric | Estimate | 95% uncertainty |
|---|---:|---:|
| Top-1 accuracy | 0.0000 | [0.0000, 0.6576] |
| Multiclass Brier | 0.8576 | [0.7162, 0.9990] |
| Natural-log loss | 1.3702 | [1.1741, 1.5663] |
| Top-label ECE | 0.4618 | [0.3547, 0.5689] |

The market baseline uses the last valid 1X2 consensus quote at or before kickoff. Probabilities are normalized; outcomes are regulation-time results, excluding extra time.

## Exclusions

- None.

## Reproduce

```powershell
node evaluation/evaluate.js
node --test evaluation/test.js
```
