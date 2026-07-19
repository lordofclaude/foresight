import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createLedgerClient, normalizeProfile, normalizeReceipt, resolveLedgerOrigin,
  safeExplorerUrl, validateOwnerId, validateReceiptId
} from "../client.js";
import { bootProofPage } from "../proof-page.js";
import { bootProfilePage } from "../profile-page.js";
import { deriveAuthoritativeProfile, evidencePresentation, renderProfile, renderReceipt } from "../renderer.js";
import { SAMPLE_OWNER_ID, SAMPLE_PROFILE, SAMPLE_RECEIPT, SAMPLE_RECEIPT_ID } from "../sample-data.js";
import { FakeDocument, FakeElement } from "./fake-dom.js";

const allowed = ["https://ledger.example.test"];
const config = { ledgerOrigin: "https://ledger.example.test", allowedLedgerOrigins: allowed };
const errorCode = code => error => error?.code === code;

test("ledger origin fails closed when missing, malformed, credentialed, or unallowlisted", () => {
  assert.throws(() => resolveLedgerOrigin({}), errorCode("missing_ledger_origin"));
  assert.throws(() => resolveLedgerOrigin({ ledgerOrigin: "not a url", allowedLedgerOrigins: allowed }), errorCode("invalid_ledger_origin"));
  assert.throws(() => resolveLedgerOrigin({ ledgerOrigin: "https://user:pass@ledger.example.test", allowedLedgerOrigins: allowed }), errorCode("invalid_ledger_origin"));
  assert.throws(() => resolveLedgerOrigin({ ledgerOrigin: "https://evil.example", allowedLedgerOrigins: allowed }), errorCode("untrusted_ledger_origin"));
  assert.equal(resolveLedgerOrigin(config), "https://ledger.example.test");
});

test("receipt and opaque owner IDs are strict and path-safe", () => {
  assert.equal(validateReceiptId(SAMPLE_RECEIPT_ID), SAMPLE_RECEIPT_ID);
  assert.equal(validateOwnerId(SAMPLE_OWNER_ID), SAMPLE_OWNER_ID);
  for (const value of ["r_../etc", "r_" + "A".repeat(64), "<script>"]) assert.throws(() => validateReceiptId(value), errorCode("invalid_receipt_id"));
  for (const value of ["../owner", "owner/name", "<img>", "x"]) assert.throws(() => validateOwnerId(value), errorCode("invalid_owner_id"));
});

test("missing ledger configuration performs no network request and renders an error", async () => {
  let fetches = 0;
  const doc = new FakeDocument(["proof-root", "load-status"]);
  await bootProofPage({ doc, locationObject: { search: "?receipt=r_" + "1".repeat(64) }, config: {}, fetchImpl: async () => { fetches++; } });
  assert.equal(fetches, 0); assert.match(doc.getElementById("proof-root").textContent, /No trusted ledger origin/);
});

test("sample URL is deterministic, visibly labeled, and never uses the network", async () => {
  let fetches = 0;
  const doc = new FakeDocument(["proof-root", "load-status"]);
  await bootProofPage({ doc, locationObject: { search: "?receipt=" + SAMPLE_RECEIPT_ID }, config: {}, fetchImpl: async () => { fetches++; } });
  assert.equal(fetches, 0); assert.match(doc.getElementById("proof-root").textContent, /SAMPLE · deterministic local fixture · not persisted history/);
});

test("sample profile URL is deterministic, visibly labeled, and never uses the network", async () => {
  let fetches = 0;
  const doc = new FakeDocument(["profile-root", "load-status"]);
  await bootProfilePage({ doc, locationObject: { search: "?owner=" + encodeURIComponent(SAMPLE_OWNER_ID) }, config: {}, fetchImpl: async () => { fetches++; } });
  assert.equal(fetches, 0); assert.match(doc.getElementById("profile-root").textContent, /SAMPLE/);
});

test("ledger client uses only the allowlisted origin and rejects non-JSON", async () => {
  let seen;
  const client = createLedgerClient(config, async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify(SAMPLE_RECEIPT), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const receipt = await client.getReceipt(SAMPLE_RECEIPT_ID);
  assert.equal(seen.url, "https://ledger.example.test/v1/receipts/" + SAMPLE_RECEIPT_ID);
  assert.equal(seen.init.credentials, "omit"); assert.equal(receipt.receiptId, SAMPLE_RECEIPT_ID);
  const bad = createLedgerClient(config, async () => new Response("<html>", { status: 200, headers: { "Content-Type": "text/html" } }));
  await assert.rejects(() => bad.getReceipt(SAMPLE_RECEIPT_ID), errorCode("invalid_ledger_response"));
});

test("renderers use text nodes only and cannot turn external strings into HTML", async () => {
  const malicious = structuredClone(SAMPLE_RECEIPT);
  malicious.evidenceChain[0].verifier = '<img src=x onerror="globalThis.pwned=1">';
  malicious.evidenceChain[0].metadata = { label: "</section><script>pwn()</script>" };
  const doc = new FakeDocument(), root = new FakeElement("main");
  renderReceipt(doc, root, normalizeReceipt(malicious), { sample: false, copy: async () => {} });
  assert.match(root.textContent, /<img src=x/); assert.equal(doc.createdTags.includes("img"), false); assert.equal(doc.createdTags.includes("script"), false);
  for (const file of ["renderer.js", "proof-page.js", "profile-page.js"]) {
    const source = await readFile(new URL("../" + file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(/);
  }
});

test("Explorer URLs are constructed only from strict signatures and networks", () => {
  const signature = "1".repeat(64);
  assert.equal(safeExplorerUrl(signature, "devnet"), `https://explorer.solana.com/tx/${signature}?cluster=devnet`);
  assert.equal(safeExplorerUrl(signature, "mainnet-beta"), `https://explorer.solana.com/tx/${signature}`);
  for (const [sig, network] of [["javascript:alert(1)", "devnet"], [signature, "testnet"], [signature + "?x=1", "devnet"]]) assert.equal(safeExplorerUrl(sig, network), null);
});

test("evidence language cannot promote mechanism-only, unverified, or not-shipped records", () => {
  const [authoritative, mechanism, planned] = SAMPLE_RECEIPT.evidenceChain;
  assert.equal(evidencePresentation(authoritative).authoritative, true);
  assert.match(evidencePresentation(mechanism).label, /MECHANISM ONLY/); assert.equal(evidencePresentation(mechanism).authoritative, false);
  assert.match(evidencePresentation(planned).label, /NOT SHIPPED/); assert.equal(evidencePresentation(planned).authoritative, false);
  assert.equal(evidencePresentation({ ...authoritative, evidenceStatus: "RECEIVED_UNVERIFIED", rootHash: null }).authoritative, false);
});

test("profile totals are recomputed from authoritative evidence, not server claims", () => {
  const profile = normalizeProfile(SAMPLE_PROFILE);
  let summary = deriveAuthoritativeProfile(profile);
  assert.deepEqual(summary, { receiptCount: 1, authoritativeGrades: 1, excludedNonAuthoritativeGrades: 0, wins: 1, pnl: 300 });
  const misleading = structuredClone(SAMPLE_PROFILE);
  misleading.receipts[0].evidenceChain[0].evidenceStatus = "RECEIVED_UNVERIFIED";
  misleading.receipts[0].evidenceChain[0].rootHash = null;
  misleading.wins = 999; misleading.pnl = 999999;
  summary = deriveAuthoritativeProfile(normalizeProfile(misleading));
  assert.deepEqual(summary, { receiptCount: 1, authoritativeGrades: 0, excludedNonAuthoritativeGrades: 1, wins: 0, pnl: 0 });
});

test("profile contract rejects cross-record, duplicate, and misleading latest-state data", () => {
  const crossRecord = structuredClone(SAMPLE_PROFILE);
  crossRecord.receipts[0].evidenceChain[0].ownerId = "attacker:owner";
  assert.throws(() => normalizeProfile(crossRecord), errorCode("invalid_ledger_response"));

  const duplicate = structuredClone(SAMPLE_PROFILE);
  duplicate.receipts[0].evidenceChain.push(structuredClone(duplicate.receipts[0].evidenceChain[0]));
  assert.throws(() => normalizeProfile(duplicate), errorCode("invalid_ledger_response"));

  const staleState = structuredClone(SAMPLE_PROFILE);
  staleState.receipts[0].state = "REVEALED";
  assert.throws(() => normalizeProfile(staleState), errorCode("invalid_ledger_response"));
});

test("profile renderer exposes SAMPLE and authoritative exclusions accessibly", () => {
  const doc = new FakeDocument(), root = new FakeElement("main");
  const misleading = structuredClone(SAMPLE_PROFILE);
  misleading.receipts[0].evidenceChain[0].evidenceStatus = "RECEIVED_UNVERIFIED"; misleading.receipts[0].evidenceChain[0].rootHash = null;
  renderProfile(doc, root, normalizeProfile(misleading), { sample: true });
  assert.match(root.textContent, /SAMPLE/); assert.match(root.textContent, /non-authoritative grade record\(s\) excluded/);
});

test("HTML and CSS include stable query entry points, CSP, mobile, print, and keyboard focus styles", async () => {
  const [proof, profile, css] = await Promise.all(["proof.html", "profile.html", "styles.css"].map(file => readFile(new URL("../" + file, import.meta.url), "utf8")));
  assert.match(proof, /proof\.html\?receipt=/); assert.match(profile, /profile\.html\?owner=/);
  assert.match(proof, /Content-Security-Policy/); assert.match(profile, /Content-Security-Policy/);
  assert.match(css, /@media\(max-width:640px\)/); assert.match(css, /@media print/); assert.match(css, /:focus-visible/);
  assert.match(proof, /aria-live="polite"/); assert.match(profile, /aria-live="polite"/);
});
