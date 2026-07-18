/* verify-wallet-flow.js — proves the REAL wallet-commit transaction shape
   works on live devnet, end to end, using the funded hackathon keypair as a
   stand-in "connected wallet" signer. This is NOT how the browser signs (the
   browser uses window.solana / Phantom, never a raw keypair) — it exists
   because headless Chrome has no wallet extension to click through, so the
   Phantom-popup UI itself can't be automated. What CAN be verified for real:
   the exact same memo built by FO.memoFor(), the exact same instruction/
   transaction shape commitRealOnChain() constructs in index.html, actually
   confirmed on devnet.
   Needs devnet SOL in _keys/wallet.json — supply your own devnet keypair
   there (gitignored; never commit a real key). Run: node verify-wallet-flow.js
*/
"use strict";
const fs = require("fs"), path = require("path");
const { Keypair, Connection, Transaction, TransactionInstruction, PublicKey, sendAndConfirmTransaction } = require("@solana/web3.js");
const FO = require("./foresight.js");

const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const KEYPATH = path.join(__dirname, "_keys", "wallet.json");

async function main() {
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEYPATH))));
  const conn = new Connection("https://api.devnet.solana.com", "confirmed");
  const balBefore = await conn.getBalance(kp.publicKey);
  console.log("stand-in wallet:", kp.publicKey.toBase58(), "(" + (balBefore / 1e9).toFixed(4) + " SOL)");

  // Identical shape to commitRealOnChain() in index.html: a real pick, real
  // memo via the SAME shared FO.memoFor(), real transaction, real broadcast.
  const pick = {
    wallet: "@you", fixtureId: 18241006 /* England v Argentina */, pick: "part2",
    mkt: { home: 0.62, draw: 0.24, away: 0.14 }, oddsTs: Date.now(),
    salt: "wallet-flow-verify-" + Date.now(),
  };
  const { memo, hash } = FO.memoFor(pick);
  console.log("memo:", memo);

  const ix = new TransactionInstruction({ keys: [], programId: MEMO_PROGRAM, data: Buffer.from(memo, "utf8") });
  const tx = new Transaction().add(ix);
  console.log("signing + sending (this is what Phantom's signAndSendTransaction does under the hood)...");
  const t0 = Date.now();
  const sig = await sendAndConfirmTransaction(conn, tx, [kp], { commitment: "confirmed" });
  const elapsed = Date.now() - t0;

  const txInfo = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const balAfter = await conn.getBalance(kp.publicKey);

  console.log("\n✅ CONFIRMED on devnet in", elapsed, "ms");
  console.log("  signature:", sig);
  console.log("  slot:", txInfo.slot, "blockTime:", new Date(txInfo.blockTime * 1000).toISOString());
  console.log("  fee paid:", ((balBefore - balAfter) / 1e9).toFixed(6), "SOL");
  console.log("  memo confirmed in logs:", txInfo.meta.logMessages.some(l => l.includes(hash)));
  console.log("  explorer: https://explorer.solana.com/tx/" + sig + "?cluster=devnet");
  console.log("\nThis proves: memo construction, transaction building, signing, broadcast,");
  console.log("and confirmation all work on real devnet infrastructure — the exact same");
  console.log("path the browser's commitRealOnChain() takes once a wallet is connected.");
  if (elapsed > 5000) console.log("\n⚠ confirmation took >5s — expect a similar wait in the browser (show a pending state).");
}
main().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
