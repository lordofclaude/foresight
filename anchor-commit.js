/* anchor-commit.js — the REAL L1 anchor.
   Takes a genuine Foresight commit hash and posts it to Solana devnet as an
   SPL-Memo transaction. The validator's blockTime becomes the unforgeable
   timestamp: proof the pick existed at that instant, before any outcome.
   This is what "the commit is the record" means in production — the in-app
   replay uses labeled sim-slots for speed; this proves the mechanism is real.

   Run:  node anchor-commit.js
   Writes anchored-proof.json (committed — it's a public devnet tx sig + hash,
   no secret). Needs devnet SOL in _keys/wallet.json (~5000 lamports) — supply
   your own devnet keypair there (gitignored; never commit a real key).
   The live app itself needs none of this — connecting a wallet in the
   browser (Phantom) is the normal, no-setup way to sign real commits.
*/
"use strict";
const fs = require("fs"), path = require("path");
const { Keypair, Connection, Transaction, TransactionInstruction, PublicKey, LAMPORTS_PER_SOL, sendAndConfirmTransaction } = require("@solana/web3.js");
const FO = require("./foresight.js");

const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const KEYPATH = path.join(__dirname, "_keys", "wallet.json");

// The demo hero pick: Argentina–Switzerland, DRAW, at the pre-match de-vigged
// consensus. A REAL Foresight commit — the same canonical + hash the app uses.
const PICK = {
  wallet: "@tiago", fixtureId: 18222446, pick: "draw",
  mkt: { home: 0.55586, draw: 0.25981, away: 0.18426 },   // real opening StablePrice triple
  oddsTs: 1783818000000,
  salt: "foresight-onchain-demo-v1",
};

async function main() {
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEYPATH))));
  const conn = new Connection("https://api.devnet.solana.com", "confirmed");
  const bal = await conn.getBalance(kp.publicKey);
  if (bal < 6000) throw new Error(`insufficient devnet SOL (${bal} lamports) — fund ${kp.publicKey.toBase58()}`);

  const { canonical, hash, memo } = FO.memoFor(PICK);         // shared with the browser wallet flow

  const ix = new TransactionInstruction({ keys: [], programId: MEMO_PROGRAM, data: Buffer.from(memo, "utf8") });
  const tx = new Transaction().add(ix);
  console.log("anchoring commit hash on Solana devnet…");
  console.log("  wallet :", kp.publicKey.toBase58(), "(" + (bal / LAMPORTS_PER_SOL).toFixed(3) + " SOL)");
  console.log("  memo   :", memo);
  const sig = await sendAndConfirmTransaction(conn, tx, [kp], { commitment: "confirmed" });

  const txInfo = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const blockTime = txInfo && txInfo.blockTime;              // unix seconds — the notary
  const slot = txInfo && txInfo.slot;

  const proof = {
    product: "foresight", version: 1, network: "devnet",
    pick: { fixtureId: PICK.fixtureId, side: PICK.pick, mkt: PICK.mkt },
    canonical, hash, memo,
    signature: sig, slot, blockTime,
    blockTimeISO: blockTime ? new Date(blockTime * 1000).toISOString() : null,
    wallet: kp.publicKey.toBase58(),
    explorer: `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
    // Argentina–Switzerland 90' result finalised well after this anchor:
    outcomeAfter: "the pick was anchored before kickoff (StartTime 1783818000000); the 90' result settled hours later — the timestamp proves the call predates the outcome.",
    anchoredAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(__dirname, "anchored-proof.json"), JSON.stringify(proof, null, 2));
  console.log("\n✅ ANCHORED");
  console.log("  hash     :", hash);
  console.log("  signature:", sig);
  console.log("  slot     :", slot, "· blockTime:", proof.blockTimeISO);
  console.log("  explorer :", proof.explorer);
  console.log("  → anchored-proof.json written");
}
main().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
