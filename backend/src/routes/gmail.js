const express = require('express');
const requireAuth = require('../middleware/auth');
const supabase = require('../lib/supabaseClient');
const { getAuthUrl, exchangeCode, GMAIL_READONLY_SCOPE, getClient } = require('../lib/googleOAuthClient');
const { createState, verifyState } = require('../lib/oauthState');
const { encrypt, decrypt } = require('../lib/tokenCrypto');
const { GMAIL_API_BASE, resolveMonths, buildSearchQuery, summarizeMessage } = require('../lib/gmailApi');
const anthropic = require('../lib/anthropicClient');
const { findPdfPart, INVOICE_EXTRACTION_SCHEMA, EXTRACTION_SYSTEM_PROMPT } = require('../lib/invoiceExtraction');

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
  const refreshToken = decrypt(connection.oauth_token);
  const client = getClient();
  client.setCredentials({ refresh_token: refreshToken });

  let message;
  try {
    // Fresh full-format fetch — deliberately NOT reusing /messages' summarized
    // output, which strips attachmentId/partId/inline body.data on purpose.
    const msgRes = await client.request({
      method: 'GET',
      url: `${GMAIL_API_BASE}/messages/${messageId}`,
      params: { format: 'full' },
    });
    message = msgRes.data;
  } catch (err) {
    if (err?.response?.data?.error === 'invalid_grant') {
      return res.status(409).json({
        error: 'gmail_reauth_required',
        message: 'Gmail access was revoked. Please reconnect Gmail.',
      });
    }
    if (err?.response?.status === 404) {
      return res.status(404).json({
        error: 'gmail_message_not_found',
        message: `No Gmail message found with id "${messageId}".`,
      });
    }
    console.error('Gmail message fetch failed:', err.message);
    return res.status(502).json({ error: 'Failed to fetch Gmail message' });
  }

  const part = findPdfPart(message.payload, partId);
  if (!part) {
    return res.status(404).json({
      error: partId ? 'pdf_part_not_found' : 'no_pdf_attachment',
      message: partId
        ? `No attachment part matching partId "${partId}" was found on this message.`
        : 'No PDF attachment was found on this message.',
    });
  }

  let gmailB64url;
  try {
    if (part.body?.data) {
      // Rare: Gmail inlines very small attachments directly in the part body.
      gmailB64url = part.body.data;
    } else {
      const attRes = await client.request({
        method: 'GET',
        url: `${GMAIL_API_BASE}/messages/${messageId}/attachments/${part.body.attachmentId}`,
      });
      gmailB64url = attRes.data.data;
    }
  } catch (err) {
    console.error('Gmail attachment fetch failed:', err.message);
    return res.status(502).json({ error: 'Failed to fetch Gmail attachment' });
  }

  // Gmail returns attachment bytes as base64url (no padding, - and _ instead
  // of + and /). Decoding as base64url yields the raw bytes; re-encoding
  // those same bytes as standard base64 is a lossless round-trip — exactly
  // what Claude's document content block requires.
  const pdfBase64 = Buffer.from(gmailB64url, 'base64url').toString('base64');

  let completion;
  try {
    // Sensitive-data flow: this PDF's financial content leaves this backend
    // and is sent to Anthropic's Claude API for extraction. Acceptable per
    // SPEC.md §3.6/§5 — Anthropic is a documented sub-processor with a
    // standard DPA; this is not itself a compliance gap, but it's exactly
    // the kind of elevated data flow that gets an inline comment.
    completion = await anthropic.messages.create({
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
  } catch (err) {
    console.error('Claude extraction failed:', err.message);
    return res.status(502).json({ error: 'Failed to extract invoice data' });
  }

  // output_config.format guarantees the first content block is type "text"
  // whose body is valid JSON matching INVOICE_EXTRACTION_SCHEMA.
  const textBlock = completion.content.find((b) => b.type === 'text');
  const extraction = JSON.parse(textBlock.text);

  res.json({
    messageId,
    partId: part.partId ?? null,
    filename: part.filename,
    extraction,
    usage: {
      input_tokens: completion.usage.input_tokens,
      output_tokens: completion.usage.output_tokens,
    },
  });
});

module.exports = router;
