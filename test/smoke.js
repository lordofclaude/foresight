/* Dependency-free static/deployment checks. Offline by default; pass --live
   only when intentionally checking the deployed app and relay over network. */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const APP_URL = "https://foresight-txline.vercel.app/";
const RELAY_HEALTH_URL = "https://foresight-relay.lordofclaude.workers.dev/health";

let passed = 0;
let failed = 0;

function check(condition, label, detail) {
  if (condition) {
    passed++;
    console.log("  ok  " + label);
  } else {
    failed++;
    console.error("FAIL  " + label + (detail ? " - " + detail : ""));
  }
}

function parseArgs(argv) {
  let live = false;
  for (const arg of argv) {
    if (arg === "--live") live = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node test/smoke.js [--live]\n\nDefault is fully offline. --live also checks the deployed app and relay health.");
      process.exit(0);
    } else throw new Error("unknown argument: " + arg);
  }
  return { live };
}

function lineAt(text, offset) {
  return text.slice(0, offset).split("\n").length;
}

function localReference(raw) {
  const value = raw.trim();
  if (!value || value.startsWith("#") || value.startsWith("//") || value.startsWith("data:") || value.startsWith("mailto:") || value.startsWith("tel:") || value.includes("${")) return null;
  try {
    const parsed = new URL(value, "https://local.invalid/");
    if (parsed.origin !== "https://local.invalid") return null;
    return decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  } catch (_) {
    return null;
  }
}

function checkReferences(file, html) {
  const missing = [];
  const tagRe = /<([a-z][\w:-]*)\b([^>]*)>/gi;
  let tag;
  while ((tag = tagRe.exec(html))) {
    const attrs = tag[2];
    const attrRe = /\s(?:src|href|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
    let attr;
    while ((attr = attrRe.exec(" " + attrs))) {
      const ref = localReference(attr[1] || attr[2] || attr[3] || "");
      if (!ref || ref.endsWith("/")) continue;
      const target = path.resolve(ROOT, ref);
      const insideRoot = target === ROOT || target.startsWith(ROOT + path.sep);
      if (!insideRoot || !fs.existsSync(target)) missing.push(ref);
    }
  }
  check(missing.length === 0, file + " local assets exist", missing.join(", "));
}

function checkInlineScripts(file, html) {
  const errors = [];
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let script;
  let inlineNumber = 0;
  while ((script = scriptRe.exec(html))) {
    const attrs = script[1];
    if (/\ssrc\s*=/i.test(" " + attrs)) continue;
    const type = (/\stype\s*=\s*["']([^"']+)["']/i.exec(" " + attrs) || [])[1];
    if (type && !/^(?:text|application)\/javascript$/i.test(type)) continue;
    inlineNumber++;
    try {
      new vm.Script(script[2], { filename: file + ":inline-" + inlineNumber });
    } catch (error) {
      errors.push("inline #" + inlineNumber + " near line " + lineAt(html, script.index) + ": " + error.message);
    }
  }
  check(errors.length === 0, file + " inline JavaScript parses (" + inlineNumber + " blocks)", errors.join("; "));
}

function checkUniqueIds(file, html) {
  const seen = new Map();
  const duplicates = [];
  const tagRe = /<[a-z][\w:-]*\b[^>]*>/gi;
  let tag;
  while ((tag = tagRe.exec(html))) {
    const idMatch = /\sid\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(tag[0]);
    if (!idMatch) continue;
    const id = idMatch[1] || idMatch[2] || idMatch[3];
    if (seen.has(id)) duplicates.push(id + " (lines " + seen.get(id) + " and " + lineAt(html, tag.index) + ")");
    else seen.set(id, lineAt(html, tag.index));
  }
  check(duplicates.length === 0, file + " DOM IDs are unique", duplicates.join(", "));
}

function checkProductLabels(html) {
  const labels = [
    ["guided demo label", /90-second demo/i],
    ["practice truth label", /PRACTICE[^<\n]{0,30}LOCAL/i],
    ["proof-flow label", /Truth-labeled data flow/i],
    ["external timestamp label", /WALLET\s*\/\s*PRE-KICKOFF/i],
    ["server-side credential label", /credentials stay server-side/i],
    ["no-custody security label", /NO CUSTODY, NO EXECUTION/i],
  ];
  for (const [label, pattern] of labels) check(pattern.test(html), "index.html " + label);
}

function checkStaticFile(file) {
  const fullPath = path.join(ROOT, file);
  check(fs.existsSync(fullPath), file + " exists");
  if (!fs.existsSync(fullPath)) return;
  const html = fs.readFileSync(fullPath, "utf8");
  checkReferences(file, html);
  checkInlineScripts(file, html);
  checkUniqueIds(file, html);
  if (file === "index.html") checkProductLabels(html);
}

function checkProofMetadata() {
  const legacy = JSON.parse(fs.readFileSync(path.join(ROOT, "anchored-proof.json"), "utf8"));
  const final = JSON.parse(fs.readFileSync(path.join(ROOT, "anchored-proof-final.json"), "utf8"));
  const settlement = JSON.parse(fs.readFileSync(path.join(ROOT, "settlement-proof.json"), "utf8"));
  const legacyKickoff = 1783818000000; // Argentina–Switzerland fixture 18222446

  check(legacy.blockTime * 1000 > legacyKickoff, "legacy anchor blockTime is post-match");
  check(/post-match|posted after/i.test(legacy.outcomeAfter) && !/before kickoff/i.test(legacy.outcomeAfter), "legacy anchor metadata says post-match");
  check(final.blockTime * 1000 < final.match.kickoff, "FINAL anchor blockTime predates kickoff");
  check(/predates|before kickoff/i.test(final.outcomeAfter), "FINAL anchor metadata says pre-kickoff");
  check(settlement.kind === "atomic-onchain-settlement" && /same transaction/i.test(settlement.claim), "settlement metadata describes atomic composition");
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    return await fetch(url, { headers: { "user-agent": "foresight-smoke/1.0" }, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function checkLive() {
  try {
    const response = await fetchWithTimeout(APP_URL);
    const body = await response.text();
    check(response.ok, "deployed app responds", "HTTP " + response.status);
    check(/<title>[^<]*Foresight/i.test(body), "deployed app serves Foresight HTML");
  } catch (error) {
    check(false, "deployed app responds", error.message);
  }

  try {
    const response = await fetchWithTimeout(RELAY_HEALTH_URL);
    const body = await response.text();
    let health = null;
    try { health = JSON.parse(body); } catch (_) {}
    check(response.ok, "deployed relay health responds", "HTTP " + response.status);
    check(health && health.ok === true, "deployed relay reports ok", body.slice(0, 160));
  } catch (error) {
    check(false, "deployed relay health responds", error.message);
  }
}

async function main() {
  const { live } = parseArgs(process.argv.slice(2));
  console.log("Foresight smoke checks (" + (live ? "static + live" : "offline static") + ")");
  checkStaticFile("index.html");
  checkProofMetadata();
  if (fs.existsSync(path.join(ROOT, "pitch.html"))) checkStaticFile("pitch.html");
  else console.log("  skip pitch.html (not present)");
  if (live) await checkLive();
  else console.log("  offline default: skipped deployed app and relay requests");

  console.log("\n" + passed + " passed, " + failed + " failed");
  if (failed) process.exit(1);
}

main().catch(error => {
  console.error("FAILED:", error.message);
  process.exit(1);
});
