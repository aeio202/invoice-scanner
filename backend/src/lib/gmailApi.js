const GMAIL_API_BASE = 'https://www.googleapis.com/gmail/v1/users/me';

const DEFAULT_MONTHS = 6;
const MIN_MONTHS = 1;
const MAX_MONTHS = 24;

// Clamps to [MIN_MONTHS, MAX_MONTHS]; any invalid/missing input just falls
// back to the default rather than a 400 — this is a dev-verification
// endpoint, not a hardened public API.
function resolveMonths(rawMonths) {
  const parsed = Number.parseInt(rawMonths, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_MONTHS;
  return Math.min(MAX_MONTHS, Math.max(MIN_MONTHS, parsed));
}

// filename:pdf (not has:attachment) — v1 scope is PDF attachments only
// (SPEC.md §2), and filename:pdf is strictly more precise. -category:promotions
// is a cheap noise filter, not the AI "real invoice vs newsletter" job from
// SPEC.md §2 (that's a future slice). Known-sender matching (SPEC.md §3.8) is
// out of scope — no vendor list exists yet.
function buildSearchQuery(months) {
  const keywords = '(invoice OR receipt OR statement OR "order confirmation" OR billing)';
  return `filename:pdf ${keywords} -category:promotions newer_than:${months}m`;
}

// payload is a MessagePart tree; multipart/* parts nest further `parts`
// arrays. A real attachment is a part with a non-empty filename and either
// body.attachmentId (normal) or inline body.data (small attachments).
function collectAttachments(part, acc = []) {
  if (!part) return acc;
  if (part.filename && part.filename.length > 0 && (part.body?.attachmentId || part.body?.data)) {
    acc.push({ filename: part.filename, mimeType: part.mimeType || null });
  }
  for (const child of part.parts || []) collectAttachments(child, acc);
  return acc;
}

function isPdfAttachment(attachment) {
  return attachment.mimeType === 'application/pdf' || attachment.filename.toLowerCase().endsWith('.pdf');
}

function findHeader(headers, name) {
  return (headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;
}

// The search query's filename:pdf operator is a first-pass filter, not a
// guarantee — this walks the real MIME structure so hasAttachment/
// hasPdfAttachment reflect what's actually in the message, not just what the
// query claimed to match.
function summarizeMessage(message) {
  const headers = message.payload?.headers || [];
  const attachments = collectAttachments(message.payload);
  return {
    id: message.id,
    threadId: message.threadId,
    subject: findHeader(headers, 'Subject'),
    from: findHeader(headers, 'From'),
    // internalDate is Gmail-set on receipt (epoch ms); the Date header is
    // sender-controlled free text and occasionally malformed.
    date: message.internalDate ? new Date(Number(message.internalDate)).toISOString() : null,
    hasAttachment: attachments.length > 0,
    hasPdfAttachment: attachments.some(isPdfAttachment),
    attachments,
  };
}

module.exports = { GMAIL_API_BASE, resolveMonths, buildSearchQuery, summarizeMessage };
