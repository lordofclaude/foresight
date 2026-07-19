/* anchor-final.js — the WORLD CUP FINAL anchor (judging-day hero artifact).
   Same mechanism as anchor-commit.js: a genuine Foresight commit hash posted
   to Solana devnet as an SPL-Memo transaction BEFORE kickoff. The validator's
   blockTime is the unforgeable timestamp: this pick provably existed before
   the final was played.

   The pick: Spain–Argentina (fixture 18257739, FIFA World Cup FINAL,
   kickoff 2026-07-19T19:00:00Z). Side = ARGENTINA (away), the underdog per
   the live pre-match TxLINE StablePrice demargined consensus fetched
   2026-07-18T23:43:52Z:
     Spain 42.070% · Draw 31.646% · Argentina 26.281%
   (messageId 1838400688:00003:000002-10021-stab, Bookmaker
   TXLineStablePriceDemargined, MarketPeriod=null → full-time 1X2 —
   the H1 market at the same ts was deliberately skipped.)
   Contrarian by design: if Argentina wins, the anchored underdog call beats
   fair odds ~3.805; if not, Foresight grades the loss honestly — the story
   is the timestamp either way.

   Run:  NODE_PATH=<repo>\08-integration\tx-on-chain\node_modules node anchor-final.js
   Writes anchored-proof-final.json (public devnet tx sig + hash, no secret).
   Costs ~5000 devnet lamports from _keys/hackathon-wallet.json. Run ONCE.
   Does NOT touch anchored-proof.json (the Argentina–Switzerland proof). */
"use strict";
const fs = require("fs"), path = require("path");
const { Keypair, Connection, Transaction, TransactionInstruction, PublicKey, LAMPORTS_PER_SOL, sendAndConfirmTransaction } = require("@solana/web3.js");
const FO = require("./foresight.js");

const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const KEYPATH = path.join(__dirname, "..", "..", "08-integration", "tx-on-chain", "_keys", "hackathon-wallet.json");
const OUT = path.join(__dirname, "anchored-proof-final.json");

// The FINAL pick — real fixture, real live consensus, real Foresight commit.
const KICKOFF = 1784487600000; // 2026-07-19T19:00:00Z
const PICK = {
  wallet: "@tiago", fixtureId: 18257739, pick: "away",   // away = part2 = Argentina (underdog)
  mkt: { home: 0.42070, draw: 0.31646, away: 0.26281 },  // live StablePrice demargined FT 1X2
  oddsTs: 1784418232498,                                 // the anchored odds message timestamp (L2-provable)
  salt: "foresight-final-onchain-v1",
};
const ODDS_MESSAGE_ID = "1838400688:00003:000002-10021-stab"; // GET /api/odds/validation?messageId=&ts=

async function main() {
  if (fs.existsSync(OUT)) throw new Error("anchored-proof-final.json already exists — the final is already anchored; refusing to double-spend the story");
  if (Date.now() >= KICKOFF) throw new Error("kickoff has passed — a post-kickoff anchor is worthless; do not run");

  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEYPATH))));
  const conn = new Connection("https://api.devnet.solana.com", "confirmed");
  const bal = await conn.getBalance(kp.publicKey);
  if (bal < 6000) throw new Error(`insufficient devnet SOL (${bal} lamports) — fund ${kp.publicKey.toBase58()}`);

  const { canonical, hash, memo } = FO.memoFor(PICK);      // shared with the browser wallet flow

  const ix = new TransactionInstruction({ keys: [], programId: MEMO_PROGRAM, data: Buffer.from(memo, "utf8") });
  const tx = new Transaction().add(ix);
  console.log("anchoring WORLD CUP FINAL commit hash on Solana devnet…");
  console.log("  wallet :", kp.publicKey.toBase58(), "(" + (bal / LAMPORTS_PER_SOL).toFixed(3) + " SOL)");
  console.log("  memo   :", memo);
  const sig = await sendAndConfirmTransaction(conn, tx, [kp], { commitment: "confirmed" });

  const txInfo = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const blockTime = txInfo && txInfo.blockTime;             // unix seconds — the notary
  const slot = txInfo && txInfo.slot;

  const proof = {
    product: "foresight", version: 1, network: "devnet",
    match: {
      fixtureId: PICK.fixtureId, competition: "World Cup FINAL",
      participant1: "Spain", participant2: "Argentina",
      kickoff: KICKOFF, kickoffISO: new Date(KICKOFF).toISOString(),
    },
    pick: {
      fixtureId: PICK.fixtureId, side: PICK.pick, sideTeam: "Argentina",
      rationale: "underdog per de-vigged StablePrice consensus (26.281% -> fair odds ~3.805)",
      mkt: PICK.mkt, oddsTs: PICK.oddsTs,
      oddsMessageId: ODDS_MESSAGE_ID,
      oddsSource: "TXLineStablePriceDemargined FT 1X2 via GET /api/odds/snapshot/18257739",
    },
    canonical, hash, memo,
    signature: sig, slot, blockTime,
    blockTimeISO: blockTime ? new Date(blockTime * 1000).toISOString() : null,
    wallet: kp.publicKey.toBase58(),
    explorer: `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
    outcomeAfter: "anchored " + Math.round((KICKOFF - Date.now()) / 60000) + " minutes BEFORE kickoff of the World Cup final — the validator blockTime proves the call predates the outcome; win or lose, it grades honestly.",
    anchoredAt: new Date().toISOString(),
  };
  fs.writeFileSync(OUT, JSON.stringify(proof, null, 2));
  console.log("\n✅ FINAL ANCHORED");
  console.log("  hash     :", hash);
  console.log("  signature:", sig);
  console.log("  slot     :", slot, "· blockTime:", proof.blockTimeISO);
  console.log("  explorer :", proof.explorer);
  console.log("  → anchored-proof-final.json written");
}
main().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
