const express = require('express');
const requireAuth = require('../middleware/auth');
const supabase = require('../lib/supabaseClient');
const { getAuthUrl, exchangeCode, GMAIL_READONLY_SCOPE, getClient } = require('../lib/googleOAuthClient');
const { createState, verifyState } = require('../lib/oauthState');
const { encrypt, decrypt } = require('../lib/tokenCrypto');
const { GMAIL_API_BASE, resolveMonths, buildSearchQuery, summarizeMessage } = require('../lib/gmailApi');
const { extractFromGmailMessage, ExtractionError } = require('../lib/invoiceExtraction');
const { scanUserInvoices } = require('../lib/scanService');

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

  try {
    const result = await scanUserInvoices(client, req.user.id, req.body?.months);
    res.json(result);
  } catch (err) {
    if (err instanceof ExtractionError) {
      const status = err.code === 'gmail_reauth_required' ? 409 : 502;
      return res.status(status).json({ error: err.code, message: err.message });
    }
    console.error('Unexpected error in /scan:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

module.exports = router;
