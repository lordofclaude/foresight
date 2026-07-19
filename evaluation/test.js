"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  splitByFixtureTime,
  assertNoFixtureLeakage,
  metricValues,
  calibration,
  wilsonInterval,
  bootstrapInterval,
  buildReport,
  regulationOutcome,
  closingPreKickoffProbabilities
} = require("./evaluate");

function observation(fixtureId, startTime, observationId) {
  return { fixtureId, startTime, observationId };
}

function fixtureEntry(fixtureId, startTime, probabilities, result = "part1") {
  const goals = result === "part1" ? [2, 0] : result === "part2" ? [0, 2] : [1, 1];
  return {
    file: `${fixtureId}.tape.js`,
    tape: {
      fixture: { FixtureId: fixtureId, StartTime: startTime, Participant1: "A", Participant2: "B" },
      historical: [{
        Action: "game_finalised",
        Stats: { "1001": goals[0], "3001": 0, "1002": goals[1], "3002": 0 }
      }],
      odds: [{
        Ts: startTime - 1,
        SuperOddsType: "1X2_PARTICIPANT_RESULT",
        PriceNames: ["part1", "draw", "part2"],
        Pct: probabilities.map(value => String(value * 100))
      }]
    }
  };
}

test("fixture/time split keeps every observation from a fixture together", () => {
  const records = [
    observation("old", 100, 1), observation("old", 100, 2),
    observation("middle", 200, 1), observation("middle", 200, 2),
    observation("new", 300, 1), observation("new", 300, 2)
  ];
  const split = splitByFixtureTime(records, 1 / 3);
  assert.deepEqual([...new Set(split.train.map(item => item.fixtureId))], ["old", "middle"]);
  assert.deepEqual([...new Set(split.holdout.map(item => item.fixtureId))], ["new"]);
  assert.equal(split.holdout.length, 2);
  assert.equal(assertNoFixtureLeakage(split), true);
});

test("leakage assertion rejects a fixture in both partitions", () => {
  assert.throws(() => assertNoFixtureLeakage({
    train: [observation("same", 100, 1)],
    holdout: [observation("same", 100, 2)]
  }), /fixture leakage detected: same/);
});

test("metric math uses multiclass Brier sum and natural-log loss", () => {
  const records = [
    { fixtureId: "a", outcome: "part1", probabilities: [0.7, 0.2, 0.1] },
    { fixtureId: "b", outcome: "draw", probabilities: [0.2, 0.5, 0.3] }
  ];
  const values = metricValues(records);
  assert.equal(values[0].correct, 1);
  assert.ok(Math.abs(values[0].brier - 0.14) < 1e-12);
  assert.ok(Math.abs(values[0].logLoss - -Math.log(0.7)) < 1e-12);
  assert.ok(Math.abs(values[1].brier - 0.38) < 1e-12);
  assert.equal(values[1].correct, 1);
});

test("top-label calibration ECE is weighted across populated bins", () => {
  const result = calibration([
    { confidence: 0.6, correct: 1 },
    { confidence: 0.8, correct: 0 }
  ], 5);
  assert.ok(Math.abs(result.expectedCalibrationError - 0.6) < 1e-12);
  assert.equal(result.bins.reduce((sum, bin) => sum + bin.count, 0), 2);
});

test("Wilson uncertainty matches the known 5/10 interval", () => {
  const [lower, upper] = wilsonInterval(5, 10);
  assert.ok(Math.abs(lower - 0.2365930905) < 1e-6);
  assert.ok(Math.abs(upper - 0.7634069095) < 1e-6);
});

test("fixture bootstrap is deterministic and refuses a meaningless one-fixture interval", () => {
  const records = [{ value: 0 }, { value: 1 }, { value: 2 }];
  const statistic = sample => sample.reduce((sum, item) => sum + item.value, 0) / sample.length;
  assert.deepEqual(bootstrapInterval(records, statistic, 500, 42), bootstrapInterval(records, statistic, 500, 42));
  assert.equal(bootstrapInterval([records[0]], statistic, 500, 42), null);
});

test("90-minute outcome excludes extra-time Total goals", () => {
  const outcome = regulationOutcome([{
    Action: "game_finalised",
    Stats: { "1001": 1, "3001": 0, "1002": 0, "3002": 1 },
    Score: { Participant1: { Total: { Goals: 3 } }, Participant2: { Total: { Goals: 1 } } }
  }]);
  assert.deepEqual(outcome.score90, [1, 1]);
  assert.equal(outcome.label, "draw");
});

test("outcome extraction refuses a final event without the required stat keys", () => {
  assert.equal(regulationOutcome([{
    Action: "game_finalised",
    Stats: { "1001": 1, "1002": 0 }
  }]), null);
});

test("baseline selects the last valid quote at or before kickoff and normalizes it", () => {
  const selected = closingPreKickoffProbabilities({
    fixture: { StartTime: 100 },
    odds: [
      { Ts: 90, SuperOddsType: "1X2_PARTICIPANT_RESULT", PriceNames: ["part1", "draw", "part2"], Pct: [40, 30, 30] },
      { Ts: 99, SuperOddsType: "1X2_PARTICIPANT_RESULT", PriceNames: ["part2", "part1", "draw"], Pct: [20, 50, 30] },
      { Ts: 101, SuperOddsType: "1X2_PARTICIPANT_RESULT", PriceNames: ["part1", "draw", "part2"], Pct: [99, 0.5, 0.5] }
    ]
  });
  assert.equal(selected.quoteTs, 99);
  assert.deepEqual(selected.probabilities, [0.5, 0.3, 0.2]);
});

test("low-N report explicitly refuses performance claims", () => {
  const entries = [
    fixtureEntry("1", 100, [0.6, 0.2, 0.2], "part1"),
    fixtureEntry("2", 200, [0.2, 0.6, 0.2], "draw"),
    fixtureEntry("3", 300, [0.2, 0.2, 0.6], "part2")
  ];
  const report = buildReport(entries, { minimumSample: 20, holdoutRatio: 1 / 3, bootstrapSamples: 100 });
  assert.equal(report.status, "pipeline-demonstration");
  assert.equal(report.claimPolicy.performanceClaimAllowed, false);
  assert.match(report.claimPolicy.message, /Performance claims refused/);
  assert.deepEqual(report.split.holdoutFixtureIds, ["3"]);
});

test("identical fixture input and seed produce identical reports", () => {
  const entries = [
    fixtureEntry("1", 100, [0.6, 0.2, 0.2], "part1"),
    fixtureEntry("2", 200, [0.2, 0.6, 0.2], "draw"),
    fixtureEntry("3", 300, [0.2, 0.2, 0.6], "part2")
  ];
  const options = { minimumSample: 1, holdoutRatio: 2 / 3, bootstrapSamples: 100, seed: 123 };
  assert.deepEqual(buildReport(entries, options), buildReport(entries, options));
});

test("threshold crossing permits qualified evaluation status", () => {
  const entries = Array.from({ length: 8 }, (_, index) =>
    fixtureEntry(String(index), index + 1, [0.6, 0.2, 0.2], "part1"));
  const report = buildReport(entries, { minimumSample: 2, holdoutRatio: 0.25, bootstrapSamples: 50 });
  assert.equal(report.claimPolicy.observedHoldoutFixtures, 2);
  assert.equal(report.claimPolicy.performanceClaimAllowed, true);
  assert.equal(report.status, "evaluation");
});
