"use strict";
const assert = require("assert");
const fs = require("fs");
const ID = require("../shared/identity-binding.js");

let passed = 0;
function ok(value, message) { assert.ok(value, message); passed++; }
async function rejects(fn, code, message) {
  await assert.rejects(fn, e => e && e.code === code, message); passed++;
}
const WALLET_A = "11111111111111111111111111111111";
const WALLET_B = "Vote111111111111111111111111111111111111111";
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const hex = value => new Uint8Array(value.match(/../g).map(byte => parseInt(byte, 16)));
function base58Encode(bytes) {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) { const n = digits[i] * 256 + carry; digits[i] = n % 58; carry = Math.floor(n / 58); }
    while (carry) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
  }
  for (let i = 0; i < bytes.length - 1 && bytes[i] === 0; i++) digits.push(0);
  return digits.reverse().map(i => B58[i]).join("");
}
let clock = Date.parse("2026-07-18T12:00:00Z"), nonceSeed = 0;
const randomBytes = size => new Uint8Array(size).fill(++nonceSeed);
const verifySignature = async ({ signature, walletAddress }) => signature === "valid:" + walletAddress;
const receiptFor = request => ({ verified: true, challengeId: request.challengeId, accountId: request.accountId, walletAddress: request.walletAddress, receiptId: "receipt-1" });
const make = extra => ID.createController({ now: () => clock, randomBytes, verifySignature, ttlMs: 60_000, ...extra });

(async () => {
  const rfcPublicKey = hex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
  const rfcSignature = hex("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b");
  ok(await ID.verifyEd25519({ message: "", signature: rfcSignature, walletAddress: base58Encode(rfcPublicKey) }), "WebCrypto verifies the deterministic RFC 8032 Ed25519 vector");

  const a = make(), b = make();
  a.signIn("user_alpha"); b.signIn("user_alpha");
  const ca = a.beginLink({ walletAddress: WALLET_A }), cb = b.beginLink({ walletAddress: WALLET_A });
  ok(ca.id !== cb.id && ca.message !== cb.message, "256-bit nonces make independently issued challenges collision-resistant");
  ok(ID.accountKey("user_alpha") !== ID.accountKey("user_alphb"), "real Clerk IDs remain distinct account keys");
  const collision = ID.createController({ now: () => clock, randomBytes: size => new Uint8Array(size).fill(7), verifySignature });
  collision.signIn("user_collision"); collision.beginLink({ walletAddress: WALLET_A });
  await rejects(async () => collision.beginLink({ walletAddress: WALLET_A }), "NONCE_COLLISION", "repeated RNG output is rejected instead of reusing a nonce");

  const expiring = make(); expiring.signIn("user_expiry");
  const expired = expiring.beginLink({ walletAddress: WALLET_A }); clock += 60_001;
  await rejects(() => expiring.submitProof({ challengeId: expired.id, accountId: "user_expiry", walletAddress: WALLET_A, signature: "valid:" + WALLET_A }), "CHALLENGE_EXPIRED", "expired nonce is rejected");
  await rejects(() => expiring.submitProof({ challengeId: expired.id, accountId: "user_expiry", walletAddress: WALLET_A, signature: "valid:" + WALLET_A }), "REPLAY_REJECTED", "expired nonce cannot be replayed");
  clock -= 60_001;

  const pending = make(); pending.signIn("user_pending");
  const pc = pending.beginLink({ walletAddress: WALLET_A });
  const ps = await pending.submitProof({ challengeId: pc.id, accountId: "user_pending", walletAddress: WALLET_A, signature: "valid:" + WALLET_A });
  ok(ps.status === "PENDING_BACKEND" && ps.clientVerified && ps.sessionOnly, "client proof alone stays explicitly pending and session-only");
  await rejects(() => pending.submitProof({ challengeId: pc.id, accountId: "user_pending", walletAddress: WALLET_A, signature: "valid:" + WALLET_A }), "REPLAY_REJECTED", "valid proof nonce cannot be replayed");

  const mismatch = make(); mismatch.signIn("user_right");
  await rejects(async () => mismatch.beginLink({ accountId: "user_wrong", walletAddress: WALLET_A }), "ACCOUNT_MISMATCH", "challenge cannot target another account");
  const mc = mismatch.beginLink({ walletAddress: WALLET_A });
  await rejects(() => mismatch.submitProof({ challengeId: mc.id, accountId: "user_wrong", walletAddress: WALLET_A, signature: "valid:" + WALLET_A }), "ACCOUNT_MISMATCH", "proof account must match current Clerk account");
  await rejects(() => mismatch.submitProof({ challengeId: mc.id, accountId: "user_right", walletAddress: WALLET_B, signature: "valid:" + WALLET_B }), "WALLET_MISMATCH", "proof wallet must match challenged wallet");

  const verified = make({ finalizeOnServer: receiptFor }); verified.signIn("user_verified");
  const vc = verified.beginLink({ walletAddress: WALLET_A });
  const vs = await verified.submitProof({ challengeId: vc.id, accountId: "user_verified", walletAddress: WALLET_A, signature: "valid:" + WALLET_A });
  ok(vs.status === "VERIFIED" && vs.walletAddress === WALLET_A && vs.backendReceiptId === "receipt-1", "exact backend receipt finalizes the session binding");
  const unlinked = verified.unlink();
  ok(unlinked.status === "ACCOUNT_ONLY" && unlinked.walletAddress === null && unlinked.backendReceiptId === null, "unlink removes wallet binding while preserving signed-in account");

  const switched = make({ finalizeOnServer: receiptFor }); switched.signIn("user_first");
  const sc = switched.beginLink({ walletAddress: WALLET_A });
  await switched.submitProof({ challengeId: sc.id, accountId: "user_first", walletAddress: WALLET_A, signature: "valid:" + WALLET_A });
  ok(switched.signIn("user_second").status === "ACCOUNT_ONLY" && switched.snapshot().walletAddress === null, "changing Clerk accounts clears the previous wallet binding");

  const badBackend = make({ finalizeOnServer: req => ({ ...receiptFor(req), walletAddress: WALLET_B }) }); badBackend.signIn("user_backend");
  const bc = badBackend.beginLink({ walletAddress: WALLET_A });
  await rejects(() => badBackend.submitProof({ challengeId: bc.id, accountId: "user_backend", walletAddress: WALLET_A, signature: "valid:" + WALLET_A }), "BACKEND_REJECTED", "mismatched backend account-wallet receipt fails closed");

  const invalid = make({ finalizeOnServer: receiptFor }); invalid.signIn("user_invalid");
  const ic = invalid.beginLink({ walletAddress: WALLET_A });
  await rejects(() => invalid.submitProof({ challengeId: ic.id, accountId: "user_invalid", walletAddress: WALLET_A, signature: "forged" }), "INVALID_SIGNATURE", "address equality without a valid signature never links");

  const html = fs.readFileSync(require("path").join(__dirname, "..", "index.html"), "utf8");
  ok(html.includes('src="shared/identity-binding.js"') && html.includes("IdentityBinding.accountKey(user.id)"), "browser integration uses the shared module and real Clerk user.id");
  ok(!fs.readFileSync(require("path").join(__dirname, "..", "shared", "identity-binding.js"), "utf8").includes("localStorage"), "binding module never persists nonce, signature, account, or wallet data client-side");

  console.log(`identity-binding: ${passed}/${passed} passed`);
})().catch(e => { console.error(e); process.exitCode = 1; });
