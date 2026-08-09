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

module.exports = { findPdfPart, INVOICE_EXTRACTION_SCHEMA, EXTRACTION_SYSTEM_PROMPT };
