#!/usr/bin/env node
/* Offline, read-only artifact inspector. It never writes ledger rows and never
   treats checked-in metadata as RPC verification. Production import must still
   pass through POST /evidence and the server-side proof verifier. */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { stableStringify } from "../src/domain.js";

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,100}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
function invariant(value, message) { if (!value) throw new Error(message); }

export function classifyFinalAnchor(artifact) {
  const canonical = JSON.parse(artifact.canonical);
  const memo = `FSGHT1|${artifact.hash}|fx${artifact.match.fixtureId}`;
  invariant(artifact.product === "foresight" && artifact.version === 1, "FINAL artifact product/version mismatch");
  invariant(HASH_RE.test(artifact.hash) && artifact.memo === memo, "FINAL memo does not bind declared hash and fixture");
  invariant(stableStringify(canonical) === artifact.canonical, "FINAL canonical bytes are not stable JSON");
  invariant(canonical.fixtureId === artifact.match.fixtureId && canonical.market === "1X2_FT", "FINAL canonical fixture/market mismatch");
  invariant(BASE58_RE.test(artifact.signature) && Number.isSafeInteger(artifact.slot), "FINAL Solana transaction metadata is invalid");
  const blockTimeMs = artifact.blockTime * 1000, leadMs = artifact.match.kickoff - blockTimeMs;
  invariant(leadMs > 0, "FINAL anchor is not pre-kickoff");
  return {
    artifact: "anchored-proof-final.json", receiptId: "r_" + artifact.hash,
    ownerId: canonical.wallet, commitHash: artifact.hash, fixtureId: canonical.fixtureId, market: canonical.market,
    evidenceKind: "SOLANA_MEMO", evidenceStatus: "VERIFIED", purpose: "PRE_KICKOFF_COMMIT",
    transitionType: "NONE", rootHash: null, slot: artifact.slot, txSignature: artifact.signature,
    messageId: artifact.pick.oddsMessageId || null, programId: null, programOwned: false,
    final: false, winner: null, observedAt: new Date(blockTimeMs).toISOString(),
    temporalRelation: "PRE_KICKOFF", minutesBeforeKickoff: Math.round(leadMs / 60000),
    gradeAuthority: false, foresightResult: "UNSETTLED_BY_THIS_ARTIFACT",
    commitHashRecomputed: false, commitHashRecomputeReason: "salt is intentionally absent from the checked-in public artifact",
    verificationScope: "CHECKED_ARTIFACT_BINDING_AND_DECLARED_BLOCKTIME_ONLY",
    requiresServerVerifier: true, importable: false,
    missingForAuthoritativeImport: ["stable ledger owner binding", "RPC transaction confirmation", "server verifier receipt"],
  };
}

export function parseTapeScript(source) {
  const prefix = "window.TXLINE_TAPE = ", trimmed = source.trim();
  invariant(trimmed.startsWith(prefix) && trimmed.endsWith(";"), "tape wrapper is invalid");
  return JSON.parse(trimmed.slice(prefix.length, -1));
}

export function classifyAtomicSettlement(artifact, tape) {
  invariant(artifact.product === "foresight" && artifact.kind === "atomic-onchain-settlement", "atomic artifact kind mismatch");
  invariant(HASH_RE.test(artifact.commitHash) && BASE58_RE.test(artifact.txSig), "atomic transaction metadata is invalid");
  invariant(artifact.fixtureId === tape.fixture.FixtureId, "atomic artifact fixture does not match tape");
  invariant(artifact.memo.includes(artifact.commitHash) && artifact.memo.includes("fx" + artifact.fixtureId) && artifact.memo.includes("commitTx=" + artifact.commitTx), "atomic memo binding is incomplete");
  const finalEvent = [...tape.historical].reverse().find(event => event.Action === "game_finalised");
  invariant(finalEvent && Number.isFinite(finalEvent.Ts), "fixture tape has no finalization timestamp");
  const settledAtMs = Date.parse(artifact.settledAt);
  invariant(Number.isFinite(settledAtMs) && settledAtMs > finalEvent.Ts, "atomic artifact is not demonstrably post-match");
  return {
    artifact: "settlement-proof.json", receiptId: "r_" + artifact.commitHash,
    ownerId: null, commitHash: artifact.commitHash, fixtureId: artifact.fixtureId, market: "1X2_FT",
    evidenceKind: "ATOMIC_CLIENT_SETTLEMENT", evidenceStatus: "MECHANISM_ONLY", purpose: "SETTLEMENT_MECHANISM",
    transitionType: "NONE", rootHash: null, slot: null, txSignature: artifact.txSig,
    messageId: null, programId: artifact.oracleProgram, programOwned: false,
    final: true, winner: null, observedAt: new Date(settledAtMs).toISOString(),
    temporalRelation: "POST_MATCH_MECHANISM", gameFinalisedAt: new Date(finalEvent.Ts).toISOString(),
    gradeAuthority: false, foresightResult: "NOT_PROVEN_BY_MECHANISM_EVIDENCE",
    composition: "CLIENT_COMPOSED_VALIDATE_STAT_PLUS_MEMO", cpiClaim: false,
    verificationScope: "CHECKED_ARTIFACT_BINDING_AND_TAPE_TIMING_ONLY",
    requiresServerVerifier: true, importable: false,
    missingForAuthoritativeImport: ["owner binding", "RPC transaction slot/confirmation", "verified outcome root"],
  };
}

export async function inspectCheckedArtifacts(paths = {}) {
  const finalUrl = paths.finalUrl || new URL("../../anchored-proof-final.json", import.meta.url);
  const settlementUrl = paths.settlementUrl || new URL("../../settlement-proof.json", import.meta.url);
  const tapeUrl = paths.tapeUrl || new URL("../../real-data/18241006.tape.js", import.meta.url);
  const [finalArtifact, settlementArtifact, tapeSource] = await Promise.all([
    readFile(finalUrl, "utf8").then(JSON.parse), readFile(settlementUrl, "utf8").then(JSON.parse), readFile(tapeUrl, "utf8"),
  ]);
  return { finalAnchor: classifyFinalAnchor(finalArtifact), atomicSettlement: classifyAtomicSettlement(settlementArtifact, parseTapeScript(tapeSource)) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  inspectCheckedArtifacts().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
