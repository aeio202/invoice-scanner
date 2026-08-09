const express = require('express');
const requireAuth = require('../middleware/auth');
const supabase = require('../lib/supabaseClient');
const { getAuthUrl, exchangeCode, GMAIL_READONLY_SCOPE } = require('../lib/googleOAuthClient');
const { createState, verifyState } = require('../lib/oauthState');
const { encrypt } = require('../lib/tokenCrypto');

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

module.exports = router;
