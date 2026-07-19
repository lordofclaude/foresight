import { createLedgerClient, normalizeReceipt, ProofPageError, validateReceiptId } from "./client.js";
import { renderError, renderReceipt } from "./renderer.js";
import { SAMPLE_RECEIPT, SAMPLE_RECEIPT_ID } from "./sample-data.js";

export async function bootProofPage({ doc = document, locationObject = location, config = globalThis.FORESIGHT_PROOF_CONFIG || {}, fetchImpl = globalThis.fetch } = {}) {
  const container = doc.getElementById("proof-root"), status = doc.getElementById("load-status");
  try {
    const receiptId = validateReceiptId(new URLSearchParams(locationObject.search).get("receipt"));
    const sample = receiptId === SAMPLE_RECEIPT_ID;
    const receipt = sample ? normalizeReceipt(SAMPLE_RECEIPT) : await createLedgerClient(config, fetchImpl).getReceipt(receiptId);
    renderReceipt(doc, container, receipt, { sample });
    doc.title = `${sample ? "SAMPLE · " : ""}Foresight proof · ${receiptId.slice(0, 14)}…`;
    status.hidden = true;
  } catch (error) {
    renderError(doc, container, error instanceof ProofPageError ? error : new ProofPageError("page_error", "The proof page could not be rendered."));
    status.hidden = true;
  }
}

if (typeof document !== "undefined") bootProofPage();
