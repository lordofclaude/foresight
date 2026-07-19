# Foresight evaluation harness

This directory evaluates a deliberately simple baseline: the most likely outcome in the last valid TxLINE 1X2 consensus quote at or before kickoff. It does **not** claim that Foresight has predictive edge.

## Assumptions and safeguards

- One tape represents one fixture. Every observation from that fixture stays in one partition.
- Fixtures are ordered by `StartTime`; the latest whole fixtures form the holdout. There is no random observation split.
- Outcomes are regulation-time 1X2 results from `game_finalised` stat keys `1001+3001` and `1002+3002`; extra time is excluded.
- The default minimum for any performance claim is 20 holdout fixtures. Below it, reports say `pipeline-demonstration` and explicitly refuse performance claims.
- Accuracy gets a 95% Wilson interval. Brier, log loss and calibration get deterministic fixture-bootstrap intervals only when at least two holdout fixtures exist.
- Multiclass Brier is the per-fixture sum of squared error over the three outcomes (range 0–2). Calibration is top-label expected calibration error over five fixed bins.

## Run

From the repository root:

```powershell
node evaluation/evaluate.js
node --test evaluation/test.js
```

Outputs are written to `evaluation/output/report.json` and `evaluation/output/report.md`. Optional CLI settings are `--input`, `--output`, `--min-sample`, and `--holdout-ratio`.

Success means the fixture IDs in train and holdout are disjoint, the metric tests pass, reports are deterministic, and low-sample output cannot be presented as a performance claim.
