/* Deployment-owned configuration. Keep null to fail closed. */
window.FORESIGHT_PROOF_CONFIG = Object.freeze({
  ledgerOrigin: null,
  allowedLedgerOrigins: Object.freeze([
    "https://foresight-ledger.lordofclaude.workers.dev",
    "http://127.0.0.1:8787",
    "http://localhost:8787"
  ])
});
