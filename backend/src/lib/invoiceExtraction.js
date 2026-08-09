const crypto = require('crypto');
const { GMAIL_API_BASE } = require('./gmailApi');
const anthropic = require('./anthropicClient');

// Walks a Gmail MessagePart tree collecting parts that look like a real PDF
// attachment. Deliberately separate from gmailApi.js's collectAttachments —
// that one is metadata-only for /messages by design; this one needs the real
// attachmentId/partId/inline body.data that /messages strips out.
function collectPdfParts(part, acc = []) {
  if (!part) return acc;
  const filename = part.filename;
  const looksLikePdf =
    filename &&
    filename.length > 0 &&
    (part.mimeType === 'application/pdf' || filename.toLowerCase().endsWith('.pdf')) &&
    (part.body?.attachmentId || part.body?.data);
  if (looksLikePdf) acc.push(part);
  for (const child of part.parts || []) collectPdfParts(child, acc);
  return acc;
}

// Returns the matching PDF MessagePart, or null if none found — either no PDF
// attachment exists on this message at all, or a partId was given and it
// doesn't match any of the PDF parts found. If no partId is given, returns
// the first PDF part found (the common single-PDF-attachment case).
function findPdfPart(payload, wantedPartId) {
  const candidates = collectPdfParts(payload);
  if (wantedPartId) return candidates.find((p) => p.partId === wantedPartId) ?? null;
  return candidates[0] ?? null;
}

const INVOICE_EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    is_invoice: {
      type: 'boolean',
      description:
        'True if this PDF is genuinely an invoice, receipt, or billing statement. False if it ' +
        'is some other kind of document (e.g. a resume, a contract, an unrelated attachment) ' +
        'that merely matched the email search heuristic.',
    },
    vendor: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description:
        'The name of the company or person who issued the invoice, exactly as printed on the ' +
        'document. Null if is_invoice is false or the vendor name cannot be confidently ' +
        'determined.',
    },
    amount: {
      anyOf: [{ type: 'number' }, { type: 'null' }],
      description:
        'The total invoice amount as a plain number, with no currency symbol and no thousands ' +
        'separators (e.g. 1234.56, not "$1,234.56"). Null if is_invoice is false or the amount ' +
        'cannot be confidently determined.',
    },
    currency: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description:
        'The ISO 4217 three-letter currency code for the amount (e.g. USD, EUR, GBP). Null if ' +
        'is_invoice is false or the currency cannot be confidently determined.',
    },
    invoice_date: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description:
        'The invoice or billing date in ISO 8601 format (YYYY-MM-DD). Null if is_invoice is ' +
        'false or the date cannot be confidently determined.',
    },
    reason: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description:
        'When is_invoice is false, a one-sentence plain-language explanation of what the ' +
        'document actually is (e.g. "This is a resume, not an invoice."). Null when is_invoice ' +
        'is true.',
    },
  },
  required: ['is_invoice', 'vendor', 'amount', 'currency', 'invoice_date', 'reason'],
  additionalProperties: false,
};

const EXTRACTION_SYSTEM_PROMPT = `You are extracting structured data from a PDF attachment found in a user's Gmail inbox. This PDF attachment was found via a heuristic email search (looking for messages that mention invoice, receipt, statement, billing, or order confirmation), so it might not actually be an invoice, receipt, or billing document — it could be an unrelated PDF that happened to match, such as a contract, a resume, a newsletter, or a manual.

First, decide whether the PDF is genuinely an invoice, receipt, or billing statement (set is_invoice accordingly).

If it is an invoice: extract the vendor name, total amount, currency, and invoice date exactly as they appear on the document. Do not guess, infer, or estimate a value that is not actually printed on the page — if a specific field cannot be confidently determined from the document, set it to null rather than filling in a plausible-looking value. Leave reason null.

If it is not an invoice, or you cannot confidently identify it as one: set is_invoice to false, set vendor, amount, currency, and invoice_date all to null, and set reason to one plain-language sentence describing what the document actually is.`;

class ExtractionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function fetchGmailMessage(gmailClient, messageId) {
  try {
    const res = await gmailClient.request({
      method: 'GET',
      url: `${GMAIL_API_BASE}/messages/${messageId}`,
      params: { format: 'full' },
    });
    return res.data;
  } catch (err) {
    if (err?.response?.data?.error === 'invalid_grant') {
      throw new ExtractionError('gmail_reauth_required', 'Gmail access was revoked. Please reconnect Gmail.');
    }
    if (err?.response?.status === 404) {
      throw new ExtractionError('gmail_message_not_found', `No Gmail message found with id "${messageId}".`);
    }
    throw new ExtractionError('gmail_fetch_failed', 'Failed to fetch Gmail message');
  }
}

async function fetchPdfBase64(gmailClient, messageId, part) {
  try {
    let gmailB64url;
    if (part.body?.data) {
      // Rare: Gmail inlines very small attachments directly in the part body.
      gmailB64url = part.body.data;
    } else {
      const attRes = await gmailClient.request({
        method: 'GET',
        url: `${GMAIL_API_BASE}/messages/${messageId}/attachments/${part.body.attachmentId}`,
      });
      gmailB64url = attRes.data.data;
    }
    // Gmail returns attachment bytes as base64url (no padding, - and _
    // instead of + and /). Decoding as base64url yields the raw bytes;
    // re-encoding those same bytes as standard base64 is a lossless
    // round-trip — exactly what Claude's document content block requires.
    return Buffer.from(gmailB64url, 'base64url').toString('base64');
  } catch (err) {
    throw new ExtractionError('attachment_fetch_failed', 'Failed to fetch Gmail attachment');
  }
}

async function callClaudeExtraction(pdfBase64) {
  try {
    // Sensitive-data flow: this PDF's financial content leaves this backend
    // and is sent to Anthropic's Claude API. Acceptable per SPEC.md §3.6/§5
    // (documented sub-processor, standard DPA) — flagged inline as the
    // elevated data flow it is.
    const completion = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      system: EXTRACTION_SYSTEM_PROMPT,
      output_config: { format: { type: 'json_schema', schema: INVOICE_EXTRACTION_SCHEMA } },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
            { type: 'text', text: 'Extract the invoice fields from this document.' },
          ],
        },
      ],
    });
    // output_config.format guarantees the first content block is type "text"
    // whose body is valid JSON matching INVOICE_EXTRACTION_SCHEMA.
    const textBlock = completion.content.find((b) => b.type === 'text');
    return { extraction: JSON.parse(textBlock.text), usage: completion.usage };
  } catch (err) {
    throw new ExtractionError('claude_failed', 'Failed to extract invoice data');
  }
}

// Fetches a Gmail message, locates its PDF attachment (by partId if given,
// else the first PDF part found), downloads the bytes, and runs Claude
// extraction on it. Shared by /extract (single message) and /scan (bulk) so
// the fetch/find/extract sequence is defined exactly once.
async function extractFromGmailMessage(gmailClient, messageId, partId) {
  const message = await fetchGmailMessage(gmailClient, messageId);
  const part = findPdfPart(message.payload, partId);
  if (!part) {
    throw new ExtractionError(
      partId ? 'pdf_part_not_found' : 'no_pdf_attachment',
      partId
        ? `No attachment part matching partId "${partId}" was found on this message.`
        : 'No PDF attachment was found on this message.',
    );
  }
  const pdfBase64 = await fetchPdfBase64(gmailClient, messageId, part);
  const { extraction, usage } = await callClaudeExtraction(pdfBase64);
  return { part, extraction, usage };
}

function normalizeVendor(vendor) {
  return vendor.trim().toLowerCase().replace(/\s+/g, ' ');
}

// vendor + exact invoice_date + amount — not user-scoped. Uniqueness across
// users is enforced by the (user_id, dedup_hash) partial unique index, not
// by the hash itself. Deliberately NOT truncated to a month: two distinct
// invoices from the same vendor in the same month (different date and/or
// amount) must not collide — see invoiceExtraction plan notes.
function computeDedupHash(vendor, invoiceDate, amount) {
  return crypto
    .createHash('sha256')
    .update(`${normalizeVendor(vendor)}|${invoiceDate}|${String(amount)}`)
    .digest('hex');
}

module.exports = {
  findPdfPart,
  INVOICE_EXTRACTION_SCHEMA,
  EXTRACTION_SYSTEM_PROMPT,
  extractFromGmailMessage,
  ExtractionError,
  computeDedupHash,
};
