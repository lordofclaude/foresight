/* Foresight account <-> Solana wallet binding.
   A browser may prove possession of a wallet, but it cannot authoritatively
   persist an account link. VERIFIED therefore requires both Ed25519 signature
   verification and an injected backend finalization seam. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.IdentityBinding = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const VERSION = 1;
  const DEFAULT_TTL_MS = 5 * 60 * 1000;
  const DOMAIN = "foresight.txline";
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

  class BindingError extends Error {
    constructor(code, message) { super(message); this.name = "BindingError"; this.code = code; }
  }

  function fail(code, message) { throw new BindingError(code, message); }
  function accountKey(accountId) {
    if (typeof accountId !== "string" || !/^user_[A-Za-z0-9_-]{4,120}$/.test(accountId)) {
      fail("INVALID_ACCOUNT", "a real Clerk user.id is required");
    }
    return "clerk:" + accountId;
  }
  function normalizeWallet(walletAddress) {
    const value = String(walletAddress || "");
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) fail("INVALID_WALLET", "a Solana base58 address is required");
    return value;
  }
  function bytesToHex(bytes) { return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join(""); }
  function secureRandomBytes(size) {
    if (!globalThis.crypto || typeof globalThis.crypto.getRandomValues !== "function") fail("CRYPTO_UNAVAILABLE", "secure randomness is unavailable");
    return globalThis.crypto.getRandomValues(new Uint8Array(size));
  }
  function challengeMessage(c) {
    return [
      "Foresight wallet ownership",
      "Version: " + VERSION,
      "Domain: " + DOMAIN,
      "Account: " + c.accountId,
      "Wallet: " + c.walletAddress,
      "Nonce: " + c.nonce,
      "Issued At: " + new Date(c.issuedAt).toISOString(),
      "Expiration Time: " + new Date(c.expiresAt).toISOString(),
      "Intent: Link this wallet to this Clerk account for this session."
    ].join("\n");
  }
  function base58Decode(value) {
    let bytes = [0];
    for (const char of value) {
      const digit = B58.indexOf(char);
      if (digit < 0) fail("INVALID_WALLET", "wallet address is not base58");
      let carry = digit;
      for (let i = 0; i < bytes.length; i++) {
        const x = bytes[i] * 58 + carry;
        bytes[i] = x & 255; carry = x >> 8;
      }
      while (carry) { bytes.push(carry & 255); carry >>= 8; }
    }
    for (let i = 0; i < value.length - 1 && value[i] === "1"; i++) bytes.push(0);
    return new Uint8Array(bytes.reverse());
  }
  function signatureBytes(signature) {
    if (signature instanceof Uint8Array) return signature;
    if (ArrayBuffer.isView(signature)) return new Uint8Array(signature.buffer, signature.byteOffset, signature.byteLength);
    if (signature instanceof ArrayBuffer) return new Uint8Array(signature);
    fail("INVALID_SIGNATURE", "wallet signature bytes are required");
  }
  async function verifyEd25519({ message, signature, walletAddress }) {
    if (!globalThis.crypto || !globalThis.crypto.subtle) fail("CRYPTO_UNAVAILABLE", "WebCrypto signature verification is unavailable");
    const publicKey = base58Decode(normalizeWallet(walletAddress));
    if (publicKey.length !== 32) fail("INVALID_WALLET", "Solana public key must be 32 bytes");
    const key = await globalThis.crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
    return globalThis.crypto.subtle.verify({ name: "Ed25519" }, key, signatureBytes(signature), new TextEncoder().encode(message));
  }

  function createController(options = {}) {
    const now = options.now || Date.now;
    const randomBytes = options.randomBytes || secureRandomBytes;
    const verifySignature = options.verifySignature || verifyEd25519;
    const finalizeOnServer = options.finalizeOnServer || null;
    const ttlMs = options.ttlMs || DEFAULT_TTL_MS;
    let accountId = null, active = null, binding = null, status = "GUEST";
    const consumed = new Set();

    function snapshot() {
      return Object.freeze({
        status, accountId, accountKey: accountId ? accountKey(accountId) : null,
        walletAddress: binding ? binding.walletAddress : active ? active.walletAddress : null,
        challengeId: active ? active.id : null, expiresAt: active ? active.expiresAt : null,
        clientVerified: status === "PENDING_BACKEND" || status === "VERIFIED",
        sessionOnly: status === "PENDING_BACKEND" || status === "VERIFIED",
        backendReceiptId: binding ? binding.receiptId : null
      });
    }
    function signIn(nextAccountId) {
      accountKey(nextAccountId);
      if (accountId !== nextAccountId) { active = null; binding = null; }
      accountId = nextAccountId; status = binding ? "VERIFIED" : "ACCOUNT_ONLY";
      return snapshot();
    }
    function signOut() { accountId = null; active = null; binding = null; status = "GUEST"; return snapshot(); }
    function beginLink(input) {
      if (!accountId) fail("SIGN_IN_REQUIRED", "sign in with Clerk before linking a wallet");
      if (input && input.accountId && input.accountId !== accountId) fail("ACCOUNT_MISMATCH", "challenge account does not match the signed-in Clerk user");
      const walletAddress = normalizeWallet(input && input.walletAddress);
      const issuedAt = Number(now()), nonceBytes = randomBytes(32);
      if (!(nonceBytes instanceof Uint8Array) || nonceBytes.length < 32) fail("WEAK_NONCE", "challenge nonce must contain at least 256 random bits");
      const nonce = bytesToHex(nonceBytes), id = "fsgt-link:" + nonce;
      if (consumed.has(id) || (active && active.id === id)) fail("NONCE_COLLISION", "challenge nonce collision");
      active = { id, accountId, walletAddress, nonce, issuedAt, expiresAt: issuedAt + ttlMs };
      active.message = challengeMessage(active); binding = null; status = "CHALLENGE_PENDING";
      return Object.freeze({ id, accountId, walletAddress, issuedAt, expiresAt: active.expiresAt, message: active.message });
    }
    async function submitProof(proof) {
      if (!active || !proof || proof.challengeId !== active.id) {
        if (proof && consumed.has(proof.challengeId)) fail("REPLAY_REJECTED", "challenge has already been consumed");
        fail("CHALLENGE_MISMATCH", "proof does not match the active challenge");
      }
      if (consumed.has(active.id)) fail("REPLAY_REJECTED", "challenge has already been consumed");
      if (Number(now()) > active.expiresAt) { consumed.add(active.id); status = "ACCOUNT_ONLY"; fail("CHALLENGE_EXPIRED", "wallet-link challenge expired"); }
      if (proof.accountId !== active.accountId || proof.accountId !== accountId) fail("ACCOUNT_MISMATCH", "proof account does not match the active Clerk user");
      if (normalizeWallet(proof.walletAddress) !== active.walletAddress) fail("WALLET_MISMATCH", "proof wallet does not match the challenged wallet");
      if (!proof.signature) fail("INVALID_SIGNATURE", "signed challenge proof is required");
      const pending = active;
      consumed.add(pending.id); // single-use before either async verifier runs
      const clientValid = await verifySignature({ message: pending.message, signature: proof.signature, walletAddress: pending.walletAddress });
      if (clientValid !== true) { status = "ACCOUNT_ONLY"; fail("INVALID_SIGNATURE", "wallet signature verification failed"); }
      status = "PENDING_BACKEND";
      if (!finalizeOnServer) return snapshot();
      const receipt = await finalizeOnServer({
        challengeId: pending.id, accountId: pending.accountId, walletAddress: pending.walletAddress,
        message: pending.message, signature: proof.signature
      });
      if (!receipt || receipt.verified !== true || receipt.challengeId !== pending.id || receipt.accountId !== pending.accountId || receipt.walletAddress !== pending.walletAddress) {
        fail("BACKEND_REJECTED", "backend did not verify this exact account, wallet, and challenge");
      }
      binding = { walletAddress: pending.walletAddress, receiptId: String(receipt.receiptId || "") || null };
      status = "VERIFIED";
      return snapshot();
    }
    function unlink() { active = null; binding = null; status = accountId ? "ACCOUNT_ONLY" : "GUEST"; return snapshot(); }
    return Object.freeze({ snapshot, signIn, signOut, beginLink, submitProof, unlink });
  }

  return Object.freeze({
    VERSION, DOMAIN, DEFAULT_TTL_MS, BindingError, accountKey, challengeMessage,
    verifyEd25519, createController,
    BACKEND_CONTRACT: Object.freeze({
      request: "{challengeId, accountId, walletAddress, message, signature}",
      response: "{verified:true, challengeId, accountId, walletAddress, receiptId}",
      rule: "Verify Clerk auth server-side, enforce nonce expiry/single-use, verify Ed25519, then persist the exact account-wallet pair."
    })
  });
});
