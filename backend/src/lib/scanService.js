const supabase = require('./supabaseClient');
const { GMAIL_API_BASE, resolveMonths, buildSearchQuery } = require('./gmailApi');
const { extractFromGmailMessage, ExtractionError, computeDedupHash } = require('./invoiceExtraction');
const { uploadInvoicePdf } = require('./invoiceStorage');

// Runs one user's scan-and-save cycle: search -> per-message extract/dedup/
// insert/upload -> update last_scan_at. Shared by POST /api/gmail/scan (one
// user, on demand) and the scheduled job (every connected user, on a timer).
// Throws ExtractionError if the search itself can't even start (revoked
// token, network failure) — callers decide what that means for them. Does
// NOT throw for per-message problems; those are recorded in the returned
// results array.
async function scanUserInvoices(gmailClient, userId, rawMonths) {
  const months = resolveMonths(rawMonths);
  const query = buildSearchQuery(months);

  let listRes;
  try {
    listRes = await gmailClient.request({
      method: 'GET',
      url: `${GMAIL_API_BASE}/messages`,
      params: { q: query, maxResults: 25 },
    });
  } catch (err) {
    if (err?.response?.data?.error === 'invalid_grant') {
      throw new ExtractionError('gmail_reauth_required', 'Gmail access was revoked. Please reconnect Gmail.');
    }
    throw new ExtractionError('gmail_search_failed', 'Failed to search Gmail messages');
  }

  const ids = (listRes.data.messages || []).map((m) => m.id);
  const results = [];

  for (const id of ids) {
    let extracted;
    try {
      extracted = await extractFromGmailMessage(gmailClient, id);
    } catch (err) {
      if (err instanceof ExtractionError) {
        // A revoked token fails identically for every remaining message —
        // stop this user's scan rather than recording N identical failures.
        if (err.code === 'gmail_reauth_required') {
          throw err;
        }
        if (err.code === 'no_pdf_attachment' || err.code === 'pdf_part_not_found') {
          results.push({ messageId: id, outcome: 'skipped_no_pdf' });
          continue;
        }
        results.push({ messageId: id, outcome: 'error', stage: 'extraction', code: err.code, message: err.message });
        continue;
      }
      console.error('Unexpected error scanning message', id, err);
      results.push({ messageId: id, outcome: 'error', stage: 'unexpected', message: err.message });
      continue;
    }

    const { extraction } = extracted;
    if (!extraction.is_invoice) {
      results.push({ messageId: id, outcome: 'skipped_not_invoice', reason: extraction.reason });
      continue;
    }

    const dedupHash =
      extraction.vendor && extraction.invoice_date && extraction.amount != null
        ? computeDedupHash(extraction.vendor, extraction.invoice_date, extraction.amount)
        : null;
    const status =
      extraction.vendor && extraction.amount != null && extraction.currency && extraction.invoice_date
        ? 'confirmed'
        : 'needs_review';

    // Plain insert + catch the unique-violation, rather than ON CONFLICT: the
    // dedup index is partial (WHERE dedup_hash IS NOT NULL), and getting
    // Postgres to infer a partial index as an ON CONFLICT arbiter needs the
    // conflict clause's WHERE to exactly mirror the index predicate. Letting
    // the DB reject the duplicate and classifying 23505 here is simpler and
    // just as correct — the constraint is still the actual source of truth.
    const { data: inserted, error: insertError } = await supabase
      .from('invoices')
      .insert({
        user_id: userId,
        vendor: extraction.vendor,
        amount: extraction.amount,
        currency: extraction.currency,
        invoice_date: extraction.invoice_date,
        status,
        source: 'attachment',
        dedup_hash: dedupHash,
      })
      .select('id')
      .maybeSingle();

    if (insertError) {
      if (insertError.code === '23505') {
        results.push({ messageId: id, outcome: 'skipped_duplicate', vendor: extraction.vendor });
      } else {
        console.error('Invoice insert failed:', insertError);
        results.push({ messageId: id, outcome: 'error', stage: 'db_insert', message: insertError.message });
      }
      continue;
    }

    // Only reached on a genuine new save — never for a duplicate, since that
    // branch already `continue`d above. This ordering (insert first, upload
    // only on success) is what makes "don't upload a PDF for an invoice
    // we're not saving" true by construction, not by upload-then-cleanup.
    let storagePath = null;
    let uploadError = null;
    try {
      storagePath = await uploadInvoicePdf(supabase, userId, inserted.id, extracted.pdfBuffer);
      const { error: linkError } = await supabase
        .from('invoices')
        .update({ storage_path: storagePath })
        .eq('id', inserted.id);
      if (linkError) {
        // Upload succeeded but the row never got linked to it — narrow, rare
        // window (a single-row UPDATE right after a successful INSERT almost
        // never fails on its own). Left unreconciled: flagged, not silently
        // ignored.
        console.error('PDF uploaded but failed to link storage_path:', linkError);
        uploadError = 'PDF uploaded but failed to record storage_path';
        storagePath = null;
      }
    } catch (err) {
      console.error('PDF upload failed:', err);
      uploadError = 'Failed to upload PDF to storage';
    }

    results.push({
      messageId: id,
      outcome: 'saved',
      invoiceId: inserted.id,
      status,
      vendor: extraction.vendor,
      storagePath,
      uploadError,
    });
  }

  // Reached only if the search succeeded and the loop ran to completion
  // (even with some per-message errors inside it) — record that this user's
  // inbox was actually checked. Skipped entirely if the function threw above
  // (revoked token / search failure): a scan that never ran isn't "scanned."
  const { error: touchError } = await supabase
    .from('email_connections')
    .update({ last_scan_at: new Date().toISOString() })
    .eq('user_id', userId);
  if (touchError) {
    // Non-fatal: the scan itself succeeded; this is bookkeeping only.
    console.error(`Failed to update last_scan_at for user ${userId}:`, touchError);
  }

  return {
    months,
    query,
    count: ids.length,
    saved: results.filter((r) => r.outcome === 'saved').length,
    skippedNotInvoice: results.filter((r) => r.outcome === 'skipped_not_invoice').length,
    skippedDuplicate: results.filter((r) => r.outcome === 'skipped_duplicate').length,
    skippedNoPdf: results.filter((r) => r.outcome === 'skipped_no_pdf').length,
    errors: results.filter((r) => r.outcome === 'error').length,
    results,
  };
}

module.exports = { scanUserInvoices };
