#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const OUTCOMES = ["part1", "draw", "part2"];
const DEFAULT_MIN_SAMPLE = 20;
const DEFAULT_HOLDOUT_RATIO = 0.3;
const DEFAULT_BOOTSTRAP_SAMPLES = 2000;
const DEFAULT_SEED = 20260718;

function parseTapeSource(source, file = "<memory>") {
  const match = source.match(/^\s*window\.TXLINE_TAPE\s*=\s*([\s\S]*?)\s*;?\s*$/);
  if (!match) throw new Error(`${file}: expected a window.TXLINE_TAPE assignment`);
  try {
    return JSON.parse(match[1]);
  } catch (error) {
    throw new Error(`${file}: tape payload is not JSON (${error.message})`);
  }
}

function discoverTapes(inputDir) {
  if (!fs.existsSync(inputDir)) return [];
  return fs.readdirSync(inputDir)
    .filter(name => name.endsWith(".tape.js"))
    .sort()
    .map(name => {
      const file = path.join(inputDir, name);
      return { file, tape: parseTapeSource(fs.readFileSync(file, "utf8"), file) };
    });
}

function regulationOutcome(historical) {
  const finalEvent = [...(historical || [])].reverse().find(event => event.Action === "game_finalised");
  if (!finalEvent || !finalEvent.Stats) return null;
  const requiredKeys = ["1001", "3001", "1002", "3002"];
  if (!requiredKeys.every(key => Object.prototype.hasOwnProperty.call(finalEvent.Stats, key))) return null;
  const value = key => Number(finalEvent.Stats[key] || 0);
  const part1Goals = value("1001") + value("3001");
  const part2Goals = value("1002") + value("3002");
  if (![part1Goals, part2Goals].every(Number.isFinite)) return null;
  return {
    label: part1Goals > part2Goals ? "part1" : part2Goals > part1Goals ? "part2" : "draw",
    score90: [part1Goals, part2Goals],
    source: "game_finalised stat keys 1001+3001 / 1002+3002"
  };
}

function closingPreKickoffProbabilities(tape) {
  const kickoff = Number(tape.fixture && tape.fixture.StartTime);
  if (!Number.isFinite(kickoff)) return null;
  const candidates = (tape.odds || []).filter(quote =>
    quote.SuperOddsType === "1X2_PARTICIPANT_RESULT" &&
    Number.isFinite(Number(quote.Ts)) && Number(quote.Ts) <= kickoff &&
    Array.isArray(quote.PriceNames) && Array.isArray(quote.Pct)
  ).sort((a, b) => Number(a.Ts) - Number(b.Ts));
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const quote = candidates[index];
    const byName = Object.fromEntries(quote.PriceNames.map((name, i) => [name, Number(quote.Pct[i])]));
    const raw = OUTCOMES.map(name => byName[name]);
    if (!raw.every(value => Number.isFinite(value) && value >= 0)) continue;
    const total = raw.reduce((sum, value) => sum + value, 0);
    if (!(total > 0)) continue;
    return {
      probabilities: raw.map(value => value / total),
      quoteTs: Number(quote.Ts),
      kickoffTs: kickoff,
      market: "1X2_PARTICIPANT_RESULT",
      selection: "last valid consensus quote at or before kickoff; normalized to sum to 1"
    };
  }
  return null;
}

function extractFixture(entry) {
  const tape = entry.tape;
  const fixture = tape.fixture || {};
  const fixtureId = String(fixture.FixtureId == null ? "" : fixture.FixtureId);
  const startTime = Number(fixture.StartTime);
  if (!fixtureId || !Number.isFinite(startTime)) {
    return { eligible: false, reason: "missing fixture ID or start time", file: entry.file };
  }
  const outcome = regulationOutcome(tape.historical);
  if (!outcome) return { eligible: false, reason: "no game_finalised regulation outcome", fixtureId, file: entry.file };
  const quote = closingPreKickoffProbabilities(tape);
  if (!quote) return { eligible: false, reason: "no valid pre-kickoff 1X2 quote", fixtureId, file: entry.file };
  return {
    eligible: true,
    fixtureId,
    startTime,
    file: entry.file,
    participants: [fixture.Participant1 || "part1", fixture.Participant2 || "part2"],
    outcome: outcome.label,
    score90: outcome.score90,
    probabilities: quote.probabilities,
    quoteTs: quote.quoteTs,
    prediction: OUTCOMES[quote.probabilities.indexOf(Math.max(...quote.probabilities))],
    confidence: Math.max(...quote.probabilities)
  };
}

function splitByFixtureTime(records, holdoutRatio = DEFAULT_HOLDOUT_RATIO) {
  if (!(holdoutRatio > 0 && holdoutRatio < 1)) throw new Error("holdoutRatio must be between 0 and 1");
  const grouped = new Map();
  for (const record of records) {
    const id = String(record.fixtureId);
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push(record);
  }
  const groups = [...grouped.entries()].map(([fixtureId, observations]) => ({
    fixtureId,
    observations,
    startTime: Math.min(...observations.map(item => Number(item.startTime)))
  })).sort((a, b) => a.startTime - b.startTime || a.fixtureId.localeCompare(b.fixtureId));
  if (groups.length < 2) return { train: [], holdout: groups.flatMap(group => group.observations) };
  const holdoutFixtures = Math.max(1, Math.ceil(groups.length * holdoutRatio));
  const cut = groups.length - holdoutFixtures;
  const split = {
    train: groups.slice(0, cut).flatMap(group => group.observations),
    holdout: groups.slice(cut).flatMap(group => group.observations)
  };
  assertNoFixtureLeakage(split);
  return split;
}

function assertNoFixtureLeakage(split) {
  const trainIds = new Set(split.train.map(item => String(item.fixtureId)));
  const overlap = [...new Set(split.holdout.map(item => String(item.fixtureId)))].filter(id => trainIds.has(id));
  if (overlap.length) throw new Error(`fixture leakage detected: ${overlap.join(", ")}`);
  return true;
}

function metricValues(records) {
  return records.map(record => {
    const actualIndex = OUTCOMES.indexOf(record.outcome);
    if (actualIndex < 0 || !Array.isArray(record.probabilities) || record.probabilities.length !== OUTCOMES.length) {
      throw new Error(`invalid evaluation record for fixture ${record.fixtureId}`);
    }
    const probabilities = record.probabilities.map(Number);
    const sum = probabilities.reduce((total, value) => total + value, 0);
    if (!probabilities.every(value => Number.isFinite(value) && value >= 0 && value <= 1) || Math.abs(sum - 1) > 1e-9) {
      throw new Error(`invalid probabilities for fixture ${record.fixtureId}`);
    }
    const predictedIndex = probabilities.indexOf(Math.max(...probabilities));
    const brier = probabilities.reduce((total, probability, index) =>
      total + (probability - (index === actualIndex ? 1 : 0)) ** 2, 0);
    return {
      correct: predictedIndex === actualIndex ? 1 : 0,
      brier,
      logLoss: -Math.log(Math.max(probabilities[actualIndex], 1e-15)),
      confidence: probabilities[predictedIndex]
    };
  });
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function calibration(values, binCount = 5) {
  const bins = Array.from({ length: binCount }, (_, index) => ({
    lower: index / binCount,
    upper: (index + 1) / binCount,
    count: 0,
    confidenceTotal: 0,
    correctTotal: 0
  }));
  for (const value of values) {
    const index = Math.min(binCount - 1, Math.floor(value.confidence * binCount));
    const bin = bins[index];
    bin.count += 1;
    bin.confidenceTotal += value.confidence;
    bin.correctTotal += value.correct;
  }
  const populated = bins.filter(bin => bin.count).map(bin => ({
    lower: bin.lower,
    upper: bin.upper,
    count: bin.count,
    meanConfidence: bin.confidenceTotal / bin.count,
    accuracy: bin.correctTotal / bin.count
  }));
  const n = values.length;
  return {
    expectedCalibrationError: n ? populated.reduce((sum, bin) =>
      sum + (bin.count / n) * Math.abs(bin.accuracy - bin.meanConfidence), 0) : null,
    bins: populated
  };
}

function wilsonInterval(successes, total, z = 1.959963984540054) {
  if (!total) return null;
  const proportion = successes / total;
  const denominator = 1 + z * z / total;
  const center = (proportion + z * z / (2 * total)) / denominator;
  const margin = z * Math.sqrt(proportion * (1 - proportion) / total + z * z / (4 * total * total)) / denominator;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function percentile(sortedValues, probability) {
  const position = (sortedValues.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedValues[lower];
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (position - lower);
}

function bootstrapInterval(records, statistic, samples = DEFAULT_BOOTSTRAP_SAMPLES, seed = DEFAULT_SEED) {
  if (records.length < 2 || samples < 1) return null;
  const random = seededRandom(seed);
  const estimates = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const resampled = Array.from({ length: records.length }, () => records[Math.floor(random() * records.length)]);
    estimates.push(statistic(resampled));
  }
  estimates.sort((a, b) => a - b);
  return [percentile(estimates, 0.025), percentile(estimates, 0.975)];
}

function evaluate(records, options = {}) {
  const samples = options.bootstrapSamples || DEFAULT_BOOTSTRAP_SAMPLES;
  const seed = options.seed || DEFAULT_SEED;
  const values = metricValues(records);
  const cal = calibration(values);
  const statistic = (resampled, key) => mean(metricValues(resampled).map(value => value[key]));
  return {
    sampleSize: records.length,
    accuracy: mean(values.map(value => value.correct)),
    accuracyWilson95: wilsonInterval(values.reduce((sum, value) => sum + value.correct, 0), values.length),
    multiclassBrier: mean(values.map(value => value.brier)),
    multiclassBrierBootstrap95: bootstrapInterval(records, sample => statistic(sample, "brier"), samples, seed),
    logLoss: mean(values.map(value => value.logLoss)),
    logLossBootstrap95: bootstrapInterval(records, sample => statistic(sample, "logLoss"), samples, seed + 1),
    topLabelCalibration: cal,
    calibrationBootstrap95: bootstrapInterval(records, sample => calibration(metricValues(sample)).expectedCalibrationError, samples, seed + 2),
    bootstrapMeaningful: records.length >= 2
  };
}

function buildReport(tapeEntries, options = {}) {
  const minimumSample = options.minimumSample || DEFAULT_MIN_SAMPLE;
  const holdoutRatio = options.holdoutRatio || DEFAULT_HOLDOUT_RATIO;
  const extracted = tapeEntries.map(extractFixture);
  const eligible = extracted.filter(item => item.eligible);
  const excluded = extracted.filter(item => !item.eligible);
  const split = splitByFixtureTime(eligible, holdoutRatio);
  const holdoutFixtureCount = new Set(split.holdout.map(item => item.fixtureId)).size;
  const claimAllowed = holdoutFixtureCount >= minimumSample;
  return {
    schemaVersion: 1,
    generatedBy: "evaluation/evaluate.js",
    deterministicSeed: options.seed || DEFAULT_SEED,
    status: claimAllowed ? "evaluation" : "pipeline-demonstration",
    claimPolicy: {
      minimumHoldoutFixtures: minimumSample,
      observedHoldoutFixtures: holdoutFixtureCount,
      performanceClaimAllowed: claimAllowed,
      message: claimAllowed
        ? "Minimum sample threshold met; metrics remain estimates with stated uncertainty."
        : `Performance claims refused: ${holdoutFixtureCount} holdout fixtures is below the minimum of ${minimumSample}.`
    },
    methodology: {
      unitOfSplit: "fixture",
      ordering: "fixture StartTime ascending",
      holdout: "latest whole fixtures",
      holdoutRatio,
      leakageCheck: "no fixture ID may occur in both train and holdout",
      prediction: "top probability from the last valid normalized pre-kickoff 1X2 consensus quote",
      outcome: "90-minute 1X2 from game_finalised stat keys 1001+3001 / 1002+3002",
      metrics: "top-1 accuracy, multiclass Brier (sum over 3 classes), natural-log loss, top-label ECE (5 bins)",
      uncertainty: "95% Wilson interval for accuracy; deterministic fixture bootstrap percentile intervals for continuous metrics when n >= 2"
    },
    discoveredTapeCount: tapeEntries.length,
    eligibleFixtureCount: eligible.length,
    excluded: excluded.map(item => ({ fixtureId: item.fixtureId || null, file: path.basename(item.file), reason: item.reason })),
    split: {
      trainFixtureIds: [...new Set(split.train.map(item => item.fixtureId))],
      holdoutFixtureIds: [...new Set(split.holdout.map(item => item.fixtureId))]
    },
    holdoutRecords: split.holdout.map(item => ({
      fixtureId: item.fixtureId,
      participants: item.participants,
      startTime: item.startTime,
      quoteTs: item.quoteTs,
      probabilities: Object.fromEntries(OUTCOMES.map((name, index) => [name, item.probabilities[index]])),
      predicted: item.prediction,
      outcome: item.outcome,
      score90: item.score90
    })),
    metrics: evaluate(split.holdout, options)
  };
}

function fixed(value, digits = 4) {
  return value == null ? "n/a" : Number(value).toFixed(digits);
}

function interval(value) {
  return value ? `[${fixed(value[0])}, ${fixed(value[1])}]` : "not meaningful at n < 2";
}

function markdownReport(report) {
  const m = report.metrics;
  const lines = [
    "# Foresight baseline evaluation",
    "",
    `> **${report.status.toUpperCase()}** — ${report.claimPolicy.message}`,
    "",
    "This report is reproducible pipeline output. It is not evidence that Foresight has predictive edge when the minimum sample threshold is not met.",
    "",
    "## Dataset and split",
    "",
    `- Checked-in tapes discovered: ${report.discoveredTapeCount}`,
    `- Eligible finalized fixtures: ${report.eligibleFixtureCount}`,
    `- Train fixtures: ${report.split.trainFixtureIds.join(", ") || "none"}`,
    `- Holdout fixtures: ${report.split.holdoutFixtureIds.join(", ") || "none"}`,
    `- Minimum holdout fixtures for a performance claim: ${report.claimPolicy.minimumHoldoutFixtures}`,
    "- Leakage control: fixtures are ordered by start time and assigned whole to train or holdout.",
    "",
    "## Descriptive holdout metrics",
    "",
    "| Metric | Estimate | 95% uncertainty |",
    "|---|---:|---:|",
    `| Top-1 accuracy | ${fixed(m.accuracy)} | ${interval(m.accuracyWilson95)} |`,
    `| Multiclass Brier | ${fixed(m.multiclassBrier)} | ${interval(m.multiclassBrierBootstrap95)} |`,
    `| Natural-log loss | ${fixed(m.logLoss)} | ${interval(m.logLossBootstrap95)} |`,
    `| Top-label ECE | ${fixed(m.topLabelCalibration.expectedCalibrationError)} | ${interval(m.calibrationBootstrap95)} |`,
    "",
    "The market baseline uses the last valid 1X2 consensus quote at or before kickoff. Probabilities are normalized; outcomes are regulation-time results, excluding extra time.",
    "",
    "## Exclusions",
    ""
  ];
  if (report.excluded.length) {
    for (const item of report.excluded) lines.push(`- ${item.fixtureId || item.file}: ${item.reason}`);
  } else {
    lines.push("- None.");
  }
  lines.push("", "## Reproduce", "", "```powershell", "node evaluation/evaluate.js", "node --test evaluation/test.js", "```", "");
  return lines.join("\n");
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith("--")) throw new Error(`unexpected argument: ${name}`);
    const value = argv[++index];
    if (value == null) throw new Error(`missing value for ${name}`);
    args[name.slice(2)] = value;
  }
  return args;
}

function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const repoRoot = path.resolve(__dirname, "..");
  const inputDir = path.resolve(args.input || path.join(repoRoot, "real-data"));
  const outputDir = path.resolve(args.output || path.join(__dirname, "output"));
  const minimumSample = args["min-sample"] == null ? DEFAULT_MIN_SAMPLE : Number(args["min-sample"]);
  const holdoutRatio = args["holdout-ratio"] == null ? DEFAULT_HOLDOUT_RATIO : Number(args["holdout-ratio"]);
  if (!Number.isInteger(minimumSample) || minimumSample < 1) throw new Error("--min-sample must be a positive integer");
  const report = buildReport(discoverTapes(inputDir), { minimumSample, holdoutRatio });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDir, "report.md"), markdownReport(report));
  process.stdout.write(`Wrote ${path.join(outputDir, "report.json")} and report.md (${report.status}).\n`);
  return report;
}

if (require.main === module) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  OUTCOMES,
  parseTapeSource,
  discoverTapes,
  regulationOutcome,
  closingPreKickoffProbabilities,
  extractFixture,
  splitByFixtureTime,
  assertNoFixtureLeakage,
  metricValues,
  calibration,
  wilsonInterval,
  bootstrapInterval,
  evaluate,
  buildReport,
  markdownReport,
  runCli
};
