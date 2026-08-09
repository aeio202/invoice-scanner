const express = require('express');
const requireAuth = require('../middleware/auth');
const supabase = require('../lib/supabaseClient');
const { getAuthUrl, exchangeCode, GMAIL_READONLY_SCOPE, getClient } = require('../lib/googleOAuthClient');
const { createState, verifyState } = require('../lib/oauthState');
const { encrypt, decrypt } = require('../lib/tokenCrypto');
const { GMAIL_API_BASE, resolveMonths, buildSearchQuery, summarizeMessage } = require('../lib/gmailApi');
const { extractFromGmailMessage, ExtractionError, computeDedupHash } = require('../lib/invoiceExtraction');
const { uploadInvoicePdf } = require('../lib/invoiceStorage');

const router = express.Router();
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:4321';

// requireAuth applied per-route (not at mount, unlike /api/me) — /callback is
// hit directly by Google's redirect with no Authorization header available.
router.get('/connect', requireAuth, (req, res) => {
  const state = createState(req.user.id);
  res.json({ url: getAuthUrl(state) });
});

router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect(`${FRONTEND_URL}/dashboard?gmail=denied`);

  const userId = verifyState(state);
  if (!userId) return res.redirect(`${FRONTEND_URL}/dashboard?gmail=error`);

  try {
    const tokens = await exchangeCode(code);
    if (!tokens.refresh_token) return res.redirect(`${FRONTEND_URL}/dashboard?gmail=error`);

    // Service-role write: bypasses RLS entirely. user_id comes from the
    // HMAC-verified state (never trust a client-supplied user_id here), so
    // no additional manual filter is needed on this INSERT — but any future
    // SELECT/UPDATE via this client must still filter by user_id manually.
    const { error: dbError } = await supabase
      .from('email_connections')
      .upsert(
        {
          user_id: userId,
          oauth_token: encrypt(tokens.refresh_token),
          scope: tokens.scope || GMAIL_READONLY_SCOPE,
          connected_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' },
      );
    if (dbError) throw dbError;

    return res.redirect(`${FRONTEND_URL}/dashboard?gmail=connected`);
  } catch (err) {
    console.error('Gmail OAuth callback failed:', err);
    return res.redirect(`${FRONTEND_URL}/dashboard?gmail=error`);
  }
});

router.get('/status', requireAuth, async (req, res) => {
  // Service-role read: bypasses RLS — must filter by user_id manually.
  const { data, error } = await supabase
    .from('email_connections')
    .select('scope, connected_at, last_scan_at')
    .eq('user_id', req.user.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: 'Failed to load connection status' });

  res.json({
    connected: !!data,
    scope: data?.scope ?? null,
    connectedAt: data?.connected_at ?? null,
    lastScanAt: data?.last_scan_at ?? null,
  });
});

router.get('/messages', requireAuth, async (req, res) => {
  // Service-role read: bypasses RLS — must filter by user_id manually.
  const { data: connection, error: dbError } = await supabase
    .from('email_connections')
    .select('oauth_token')
    .eq('user_id', req.user.id)
    .maybeSingle();
  if (dbError) return res.status(500).json({ error: 'Failed to load Gmail connection' });
  if (!connection) return res.status(404).json({ error: 'Gmail not connected' });

  const months = resolveMonths(req.query.months);
  const query = buildSearchQuery(months);

  try {
    // Elevated operation: decrypts the stored Gmail refresh token and uses it
    // to mint a live Google access token. The plaintext refresh token lives
    // only in this function's scope — never logged, never echoed in a
    // response, never persisted anywhere beyond the ciphertext already in
    // email_connections.oauth_token.
    const refreshToken = decrypt(connection.oauth_token);
    const client = getClient();
    client.setCredentials({ refresh_token: refreshToken });

    const listRes = await client.request({
      method: 'GET',
      url: `${GMAIL_API_BASE}/messages`,
      params: { q: query, maxResults: 25 },
    });

    const ids = (listRes.data.messages || []).map((m) => m.id);
    const messages = await Promise.all(
      ids.map((id) =>
        client.request({ method: 'GET', url: `${GMAIL_API_BASE}/messages/${id}`, params: { format: 'full' } }),
      ),
    );

    res.json({
      months,
      query,
      resultSizeEstimate: listRes.data.resultSizeEstimate ?? null,
      count: messages.length,
      candidates: messages.map((m) => summarizeMessage(m.data)),
    });
  } catch (err) {
    if (err?.response?.data?.error === 'invalid_grant') {
      return res.status(409).json({
        error: 'gmail_reauth_required',
        message: 'Gmail access was revoked. Please reconnect Gmail.',
      });
    }
    console.error('Gmail messages fetch failed:', err.message);
    res.status(502).json({ error: 'Failed to fetch Gmail messages' });
  }
});

router.post('/extract', requireAuth, async (req, res) => {
  const { messageId, partId } = req.body || {};
  if (!messageId || typeof messageId !== 'string') {
    return res.status(400).json({ error: 'messageId is required' });
  }

  // Service-role read: bypasses RLS — must filter by user_id manually.
  const { data: connection, error: dbError } = await supabase
    .from('email_connections')
    .select('oauth_token')
    .eq('user_id', req.user.id)
    .maybeSingle();
  if (dbError) return res.status(500).json({ error: 'Failed to load Gmail connection' });
  if (!connection) return res.status(404).json({ error: 'Gmail not connected' });

  // Elevated operation: decrypts the stored Gmail refresh token — same
  // decrypt → getClient() → setCredentials pattern already proven in
  // /messages. The plaintext refresh token lives only in this function's
  // scope — never logged, never echoed in a response.
  const client = getClient();
  client.setCredentials({ refresh_token: decrypt(connection.oauth_token) });

  try {
    const { part, extraction, usage } = await extractFromGmailMessage(client, messageId, partId);
    res.json({
      messageId,
      partId: part.partId ?? null,
      filename: part.filename,
      extraction,
      usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
    });
  } catch (err) {
    if (err instanceof ExtractionError) {
      const statusByCode = {
        gmail_reauth_required: 409,
        gmail_message_not_found: 404,
        no_pdf_attachment: 404,
        pdf_part_not_found: 404,
        gmail_fetch_failed: 502,
        attachment_fetch_failed: 502,
        claude_failed: 502,
      };
      return res.status(statusByCode[err.code] || 500).json({ error: err.code, message: err.message });
    }
    console.error('Unexpected error in /extract:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

router.post('/scan', requireAuth, async (req, res) => {
  // Service-role read: bypasses RLS — must filter by user_id manually.
  const { data: connection, error: dbError } = await supabase
    .from('email_connections')
    .select('oauth_token')
    .eq('user_id', req.user.id)
    .maybeSingle();
  if (dbError) return res.status(500).json({ error: 'Failed to load Gmail connection' });
  if (!connection) return res.status(404).json({ error: 'Gmail not connected' });

  const client = getClient();
  client.setCredentials({ refresh_token: decrypt(connection.oauth_token) });

  const months = resolveMonths(req.body?.months);
  const query = buildSearchQuery(months);

  let listRes;
  try {
    listRes = await client.request({
      method: 'GET',
      url: `${GMAIL_API_BASE}/messages`,
      params: { q: query, maxResults: 25 },
    });
  } catch (err) {
    if (err?.response?.data?.error === 'invalid_grant') {
      return res.status(409).json({
        error: 'gmail_reauth_required',
        message: 'Gmail access was revoked. Please reconnect Gmail.',
      });
    }
    console.error('Gmail search failed:', err.message);
    return res.status(502).json({ error: 'Failed to search Gmail messages' });
  }

  const ids = (listRes.data.messages || []).map((m) => m.id);
  const results = [];

  for (const id of ids) {
    let extracted;
    try {
      extracted = await extractFromGmailMessage(client, id);
    } catch (err) {
      if (err instanceof ExtractionError) {
        // A revoked token fails identically for every remaining message —
        // stop the whole scan rather than recording N identical failures.
        if (err.code === 'gmail_reauth_required') {
          return res.status(409).json({
            error: 'gmail_reauth_required',
            message: err.message,
            partialResults: results,
          });
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
        user_id: req.user.id,
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
      storagePath = await uploadInvoicePdf(supabase, req.user.id, inserted.id, extracted.pdfBuffer);
      const { error: linkError } = await supabase
        .from('invoices')
        .update({ storage_path: storagePath })
        .eq('id', inserted.id);
      if (linkError) {
        // Upload succeeded but the row never got linked to it — narrow, rare
        // window (a single-row UPDATE right after a successful INSERT almost
        // never fails on its own). Left unreconciled this slice: flagged,
        // not silently ignored.
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

  res.json({
    months,
    query,
    count: ids.length,
    saved: results.filter((r) => r.outcome === 'saved').length,
    skippedNotInvoice: results.filter((r) => r.outcome === 'skipped_not_invoice').length,
    skippedDuplicate: results.filter((r) => r.outcome === 'skipped_duplicate').length,
    skippedNoPdf: results.filter((r) => r.outcome === 'skipped_no_pdf').length,
    errors: results.filter((r) => r.outcome === 'error').length,
    results,
  });
});

module.exports = router;
