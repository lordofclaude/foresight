import { createLedgerClient, normalizeProfile, ProofPageError, validateOwnerId } from "./client.js";
import { renderError, renderProfile } from "./renderer.js";
import { SAMPLE_OWNER_ID, SAMPLE_PROFILE } from "./sample-data.js";

export async function bootProfilePage({ doc = document, locationObject = location, config = globalThis.FORESIGHT_PROOF_CONFIG || {}, fetchImpl = globalThis.fetch } = {}) {
  const container = doc.getElementById("profile-root"), status = doc.getElementById("load-status");
  try {
    const ownerId = validateOwnerId(new URLSearchParams(locationObject.search).get("owner"));
    const sample = ownerId === SAMPLE_OWNER_ID;
    const profile = sample ? normalizeProfile(SAMPLE_PROFILE) : await createLedgerClient(config, fetchImpl).getProfile(ownerId);
    renderProfile(doc, container, profile, { sample });
    doc.title = `${sample ? "SAMPLE · " : ""}Foresight profile · ${ownerId}`;
    status.hidden = true;
  } catch (error) {
    renderError(doc, container, error instanceof ProofPageError ? error : new ProofPageError("page_error", "The profile page could not be rendered."));
    status.hidden = true;
  }
}

if (typeof document !== "undefined") bootProfilePage();
