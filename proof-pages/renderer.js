import { safeExplorerUrl } from "./client.js";

const STATES = new Set(["COMMITTED", "REVEALED", "GRADED", "BURNED", "INVALID"]);
function display(value, fallback = "—", max = 512) {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value).slice(0, max);
}
function date(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium", timeZone: "UTC" }) + " UTC" : "Invalid timestamp";
}
function el(doc, tag, text, className) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = display(text, "", 8192);
  return node;
}
function labeled(doc, label, value, className = "fact") {
  const row = el(doc, "div", undefined, className);
  row.append(el(doc, "span", label, "fact-label"), el(doc, "strong", value, "fact-value"));
  return row;
}
function section(doc, title, id) {
  const node = el(doc, "section", undefined, "panel");
  const heading = el(doc, "h2", title); heading.id = id;
  node.setAttribute("aria-labelledby", id); node.append(heading);
  return node;
}
function copyButton(doc, label, value, copyImpl) {
  const button = el(doc, "button", label, "copy-button"); button.type = "button";
  button.setAttribute("aria-label", label);
  button.addEventListener("click", async () => {
    try { await copyImpl(String(value)); button.textContent = "Copied"; }
    catch (_) { button.textContent = "Copy failed"; }
  });
  return button;
}
function defaultCopy(value) {
  if (!globalThis.navigator?.clipboard?.writeText) return Promise.reject(new Error("clipboard unavailable"));
  return globalThis.navigator.clipboard.writeText(value);
}

export function evidencePresentation(evidence) {
  if (evidence.evidenceKind === "API_RECEIPT" && evidence.evidenceStatus === "VERIFIED" && evidence.purpose === "OUTCOME_VALIDATION" && evidence.final && evidence.rootHash && evidence.programOwned === false) {
    return { label: "AUTHORITATIVE VALIDATION", tone: "verified", authoritative: true, explanation: "Verifier-approved final outcome with a stored validation root." };
  }
  if (evidence.evidenceKind === "API_RECEIPT") return { label: "UNVERIFIED API RECEIPT", tone: "warning", authoritative: false, explanation: "API data was received but is not cryptographically authoritative and is not counted." };
  if (evidence.evidenceKind === "SOLANA_MEMO") return { label: "COMMIT ANCHOR · NOT A GRADE", tone: "anchor", authoritative: false, explanation: "The transaction can timestamp a commitment; it does not prove the outcome." };
  if (evidence.evidenceKind === "ATOMIC_CLIENT_SETTLEMENT") return { label: "MECHANISM ONLY · NOT A FORESIGHT RESULT", tone: "mechanism", authoritative: false, explanation: "Client-composed validation and memo instructions in one transaction are not program-owned grade state." };
  if (evidence.evidenceKind === "PROGRAM_STATE" && evidence.evidenceStatus === "NOT_SHIPPED") return { label: "PROGRAM STATE · NOT SHIPPED", tone: "not-shipped", authoritative: false, explanation: "Program-owned durable grade state is planned, not currently shipped." };
  return { label: "NON-AUTHORITATIVE EVIDENCE", tone: "warning", authoritative: false, explanation: "This record is displayed for audit context and is not counted as proof of a result." };
}

export function isAuthoritativeGrade(receipt) {
  if (receipt.state !== "GRADED" || !receipt.latestEvent && !receipt.events?.length) return false;
  const event = receipt.latestEvent || receipt.events.at(-1);
  if (event?.type !== "GRADED" || !event.payload?.evidenceId) return false;
  const evidence = receipt.evidenceChain.find(item => item.evidenceId === event.payload.evidenceId);
  const view = evidence && evidencePresentation(evidence);
  return !!view?.authoritative && evidence.transitionType === "GRADED" && evidence.receiptId === receipt.receiptId && evidence.commitHash === receipt.commitHash && evidence.winner === event.payload.winner;
}

export function deriveAuthoritativeProfile(profile) {
  let grades = 0, wins = 0, pnl = 0, excluded = 0;
  for (const receipt of profile.receipts) {
    if (receipt.state !== "GRADED") continue;
    if (!isAuthoritativeGrade(receipt)) { excluded++; continue; }
    grades++;
    const event = receipt.latestEvent || receipt.events.at(-1);
    if (event.payload.result === "WIN") wins++;
    if (Number.isFinite(event.payload.pnl)) pnl += event.payload.pnl;
  }
  return Object.freeze({ receiptCount: profile.receipts.length, authoritativeGrades: grades, excludedNonAuthoritativeGrades: excluded, wins, pnl: Math.round(pnl * 100) / 100 });
}

function evidenceCard(doc, evidence) {
  const view = evidencePresentation(evidence);
  const card = el(doc, "article", undefined, "evidence-card " + view.tone);
  const heading = el(doc, "h3", view.label); card.append(heading, el(doc, "p", view.explanation, "evidence-explanation"));
  const facts = el(doc, "div", undefined, "fact-grid");
  facts.append(
    labeled(doc, "Kind", evidence.evidenceKind), labeled(doc, "Status", evidence.evidenceStatus),
    labeled(doc, "Observed", date(evidence.observedAt)), labeled(doc, "Verifier", evidence.verifier),
    labeled(doc, "Root", evidence.rootHash || "None"), labeled(doc, "Slot", evidence.slot ?? "None"),
    labeled(doc, "Message", evidence.messageId || "None"), labeled(doc, "Program-owned", evidence.programOwned ? "Yes" : "No")
  );
  card.append(facts);
  const network = evidence.metadata?.network;
  const explorer = safeExplorerUrl(evidence.txSignature, network);
  if (explorer) { const link = el(doc, "a", "Open transaction in Solana Explorer", "explorer-link"); link.href = explorer; link.target = "_blank"; link.rel = "noopener noreferrer"; card.append(link); }
  return card;
}

function timelineEvent(doc, event) {
  const item = el(doc, "li", undefined, "timeline-event state-" + display(event.type, "unknown").toLowerCase());
  item.append(el(doc, "strong", STATES.has(event.type) ? event.type : "UNKNOWN EVENT"), el(doc, "time", date(event.createdAt)));
  if (event.type === "GRADED") item.append(el(doc, "p", `${display(event.payload.result)} · winner ${display(event.payload.winner)} · P&L ${Number.isFinite(event.payload.pnl) ? "$" + event.payload.pnl.toFixed(2) : "unavailable"}`));
  if (event.type === "BURNED" || event.type === "INVALID") item.append(el(doc, "p", display(event.payload.reason)));
  return item;
}

export function formatCanonical(receipt) {
  const reveal = receipt.events?.find(event => event.type === "REVEALED");
  if (!reveal || typeof reveal.payload?.canonical !== "string") return null;
  try { return JSON.stringify(JSON.parse(reveal.payload.canonical), null, 2); } catch (_) { return null; }
}

export function renderReceipt(doc, container, receipt, options = {}) {
  const copyImpl = options.copy || defaultCopy;
  container.replaceChildren();
  if (options.sample) container.append(el(doc, "div", "SAMPLE · deterministic local fixture · not persisted history", "sample-banner"));
  const intro = el(doc, "header", undefined, "page-intro");
  intro.append(el(doc, "p", "PUBLIC PROOF RECEIPT", "eyebrow"), el(doc, "h1", `Fixture ${receipt.fixtureId}`), el(doc, "p", `Receipt ${receipt.receiptId}`, "mono wrap"));
  container.append(intro);

  const commit = section(doc, "1 · Commitment", "commit-heading");
  const commitFacts = el(doc, "div", undefined, "fact-grid");
  commitFacts.append(labeled(doc, "State", receipt.state), labeled(doc, "Committed", date(receipt.committedAt)), labeled(doc, "Owner", receipt.ownerId), labeled(doc, "Market", receipt.market));
  commit.append(commitFacts);
  const hashRow = el(doc, "div", undefined, "copy-row"); hashRow.append(el(doc, "code", receipt.commitHash, "wrap"), copyButton(doc, "Copy commitment hash", receipt.commitHash, copyImpl)); commit.append(hashRow);
  const anchor = receipt.anchor || {};
  const anchorFacts = el(doc, "div", undefined, "anchor-box");
  anchorFacts.append(el(doc, "h3", "External timestamp anchor"), el(doc, "p", anchor.signature ? `Solana ${display(anchor.network)} · slot ${display(anchor.slot)}` : "No validated external transaction signature is present."));
  const anchorExplorer = safeExplorerUrl(anchor.signature, anchor.network);
  if (anchorExplorer) { const link = el(doc, "a", "Open anchor in Solana Explorer", "explorer-link"); link.href = anchorExplorer; link.target = "_blank"; link.rel = "noopener noreferrer"; anchorFacts.append(link); }
  commit.append(anchorFacts); container.append(commit);

  const lifecycle = section(doc, "2 · Reveal and grade", "lifecycle-heading");
  const timeline = el(doc, "ol", undefined, "timeline"); receipt.events.forEach(event => timeline.append(timelineEvent(doc, event))); lifecycle.append(timeline);
  const canonical = formatCanonical(receipt);
  if (canonical) { const canonicalBox = el(doc, "div", undefined, "canonical-box"); canonicalBox.append(el(doc, "h3", "Canonical revealed JSON"), el(doc, "pre", canonical), copyButton(doc, "Copy canonical JSON", canonical, copyImpl)); lifecycle.append(canonicalBox); }
  container.append(lifecycle);

  const evidence = section(doc, "3 · Validation evidence", "evidence-heading");
  if (!receipt.evidenceChain.length) evidence.append(el(doc, "p", "No persisted validation evidence is attached.", "empty-state"));
  else receipt.evidenceChain.forEach(item => evidence.append(evidenceCard(doc, item)));
  container.append(evidence);
  return container;
}

function receiptCard(doc, receipt) {
  const authoritative = isAuthoritativeGrade(receipt);
  const card = el(doc, "article", undefined, "receipt-card " + (authoritative ? "authoritative" : "context-only"));
  const title = el(doc, "h3", `Fixture ${receipt.fixtureId} · ${receipt.state}`);
  const proof = el(doc, "a", "Open proof receipt", "proof-link"); proof.href = "proof.html?receipt=" + encodeURIComponent(receipt.receiptId);
  card.append(title, el(doc, "p", authoritative ? "Authoritative grade counted" : "Not counted as an authoritative grade", "receipt-authority"), labeled(doc, "Committed", date(receipt.committedAt)), proof);
  receipt.evidenceChain.forEach(item => card.append(evidenceCard(doc, item)));
  return card;
}

export function renderProfile(doc, container, profile, options = {}) {
  container.replaceChildren();
  if (options.sample) container.append(el(doc, "div", "SAMPLE · deterministic local fixture · not persisted history", "sample-banner"));
  const summary = deriveAuthoritativeProfile(profile);
  const intro = el(doc, "header", undefined, "page-intro"); intro.append(el(doc, "p", "PUBLIC PROPHET PROFILE", "eyebrow"), el(doc, "h1", profile.ownerId, "wrap")); container.append(intro);
  const metrics = section(doc, "Authoritative record", "record-heading");
  const grid = el(doc, "div", undefined, "metric-grid");
  grid.append(labeled(doc, "Receipts", summary.receiptCount, "metric"), labeled(doc, "Authoritative grades", summary.authoritativeGrades, "metric"), labeled(doc, "Wins", summary.wins, "metric"), labeled(doc, "P&L", `$${summary.pnl.toFixed(2)}`, "metric"));
  metrics.append(grid);
  if (summary.excludedNonAuthoritativeGrades) metrics.append(el(doc, "p", `${summary.excludedNonAuthoritativeGrades} non-authoritative grade record(s) excluded from totals.`, "warning-note"));
  container.append(metrics);
  const history = section(doc, "Receipt history", "history-heading");
  if (!profile.receipts.length) history.append(el(doc, "p", "No public receipts found.", "empty-state"));
  else profile.receipts.forEach(receipt => history.append(receiptCard(doc, receipt)));
  container.append(history);
  return container;
}

export function renderError(doc, container, error) {
  container.replaceChildren();
  const panel = el(doc, "section", undefined, "error-panel"); panel.setAttribute("role", "alert");
  panel.append(el(doc, "p", "PROOF PAGE UNAVAILABLE", "eyebrow"), el(doc, "h1", "Unable to load this public record"), el(doc, "p", display(error?.message, "Unknown error")));
  container.append(panel); return container;
}
