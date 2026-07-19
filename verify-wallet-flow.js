/* Offline by default: verifies the wallet-commit transaction shape without
   reading a key, making an RPC request, or broadcasting. A live devnet proof
   remains available only through the explicit --broadcast path; it requires a
   user-supplied key path and a separate confirmation-intent flag.
*/
"use strict";
const fs = require("fs"), path = require("path");
const { Keypair, Connection, Transaction, TransactionInstruction, PublicKey, sendAndConfirmTransaction } = require("@solana/web3.js");
const FO = require("./foresight.js");

const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const DEVNET_RPC = "https://api.devnet.solana.com";
const OFFLINE_PUBLIC_KEY = new PublicKey("11111111111111111111111111111111");
const CONFIRM_FLAG = "--yes-i-understand-this-broadcasts";

function usage() {
  console.log(`Usage:
  node verify-wallet-flow.js [--dry-run]
  node verify-wallet-flow.js --broadcast --key <devnet-keypair.json> ${CONFIRM_FLAG}

Default and --dry-run are offline and never read a private key or broadcast.
--broadcast sends one memo transaction to Solana devnet and pays its fee.`);
}

function parseArgs(argv) {
  const opts = { dryRun: false, broadcast: false, keyPath: null, confirmed: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--broadcast") opts.broadcast = true;
    else if (arg === "--key") {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("--key requires a path");
      opts.keyPath = argv[++i];
    } else if (arg === CONFIRM_FLAG) opts.confirmed = true;
    else throw new Error("unknown argument: " + arg);
  }
  if (opts.dryRun && opts.broadcast) throw new Error("choose either --dry-run or --broadcast, not both");
  if (!opts.broadcast && (opts.keyPath || opts.confirmed)) throw new Error("--key and the confirmation flag are valid only with --broadcast");
  if (opts.broadcast && !opts.keyPath) throw new Error("--broadcast requires --key <devnet-keypair.json>");
  if (opts.broadcast && !opts.confirmed) throw new Error("--broadcast requires explicit confirmation intent: " + CONFIRM_FLAG);
  return opts;
}

function buildPick(live) {
  return {
    wallet: "@you",
    fixtureId: 18241006,
    pick: "part2",
    mkt: { home: 0.62, draw: 0.24, away: 0.14 },
    oddsTs: live ? Date.now() : 1784419200000,
    salt: live ? "wallet-flow-verify-" + Date.now() : "wallet-flow-offline-shape-v1",
  };
}

function buildCommitTransaction(pick) {
  const proof = FO.memoFor(pick);
  const ix = new TransactionInstruction({
    keys: [],
    programId: MEMO_PROGRAM,
    data: Buffer.from(proof.memo, "utf8"),
  });
  return { ...proof, transaction: new Transaction().add(ix) };
}

function assertTransactionShape(transaction, memo, hash) {
  if (transaction.instructions.length !== 1) throw new Error("expected exactly one memo instruction");
  const ix = transaction.instructions[0];
  if (!ix.programId.equals(MEMO_PROGRAM)) throw new Error("unexpected instruction program");
  if (ix.keys.length !== 0) throw new Error("memo instruction must not contain account keys");
  if (Buffer.from(ix.data).toString("utf8") !== memo) throw new Error("instruction bytes do not match the memo");
  if (memo !== "FSGHT1|" + hash + "|fx18241006") throw new Error("unexpected Foresight memo envelope");
  if (Buffer.byteLength(memo, "utf8") >= 566) throw new Error("memo exceeds Solana's practical memo size limit");
}

function runDryRun() {
  const { memo, hash, transaction } = buildCommitTransaction(buildPick(false));
  assertTransactionShape(transaction, memo, hash);

  // Deterministic public placeholders make the unsigned message compile. No
  // secret material or network blockhash is needed for this shape check.
  transaction.feePayer = OFFLINE_PUBLIC_KEY;
  transaction.recentBlockhash = OFFLINE_PUBLIC_KEY.toBase58();
  const messageBytes = transaction.serializeMessage();
  if (!messageBytes.length) throw new Error("compiled transaction message is empty");

  console.log("DRY RUN: wallet commit transaction shape is valid");
  console.log("  memo:", memo);
  console.log("  program:", MEMO_PROGRAM.toBase58());
  console.log("  instructions: 1; account keys: 0; message bytes:", messageBytes.length);
  console.log("  no private key read; no RPC request made; no transaction broadcast");
}

function readUserKeypair(keyArg) {
  const keyPath = path.resolve(process.cwd(), keyArg);
  const parsed = JSON.parse(fs.readFileSync(keyPath, "utf8"));
  if (!Array.isArray(parsed) || parsed.length !== 64 || parsed.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error("key file must be a Solana JSON array containing exactly 64 byte values");
  }
  return Keypair.fromSecretKey(Uint8Array.from(parsed));
}

async function runBroadcast(keyArg) {
  const kp = readUserKeypair(keyArg);
  const conn = new Connection(DEVNET_RPC, "confirmed");
  const balBefore = await conn.getBalance(kp.publicKey);
  console.log("BROADCAST explicitly confirmed; devnet only");
  console.log("stand-in wallet:", kp.publicKey.toBase58(), "(" + (balBefore / 1e9).toFixed(4) + " SOL)");

  const { memo, hash, transaction } = buildCommitTransaction(buildPick(true));
  assertTransactionShape(transaction, memo, hash);
  console.log("memo:", memo);
  console.log("signing + sending (this is what Phantom's signAndSendTransaction does under the hood)...");
  const t0 = Date.now();
  const sig = await sendAndConfirmTransaction(conn, transaction, [kp], { commitment: "confirmed" });
  const elapsed = Date.now() - t0;

  const txInfo = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const balAfter = await conn.getBalance(kp.publicKey);
  if (!txInfo) throw new Error("confirmed transaction could not be fetched");

  console.log("\nCONFIRMED on devnet in", elapsed, "ms");
  console.log("  signature:", sig);
  console.log("  slot:", txInfo.slot, "blockTime:", new Date(txInfo.blockTime * 1000).toISOString());
  console.log("  fee paid:", ((balBefore - balAfter) / 1e9).toFixed(6), "SOL");
  console.log("  memo confirmed in logs:", txInfo.meta.logMessages.some(line => line.includes(hash)));
  console.log("  explorer: https://explorer.solana.com/tx/" + sig + "?cluster=devnet");
  if (elapsed > 5000) console.log("\nConfirmation took >5s; expect a similar pending state in the browser.");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { usage(); return; }
  if (opts.broadcast) await runBroadcast(opts.keyPath);
  else runDryRun();
}

main().catch(error => {
  console.error("FAILED:", error.message);
  console.error("Run with --help for safe usage details.");
  process.exit(1);
});
