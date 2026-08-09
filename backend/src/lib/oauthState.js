const crypto = require('crypto');

const TTL_MS = 5 * 60 * 1000;

function getSecret() {
  const secret = process.env.GMAIL_OAUTH_STATE_SECRET;
  if (!secret) throw new Error('GMAIL_OAUTH_STATE_SECRET is not set');
  return secret;
}

// Called only from GET /api/gmail/connect, where req.user.id is already
// verified by requireAuth — the state payload's uid is never client-supplied.
function createState(userId) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, exp: Date.now() + TTL_MS })).toString('base64url');
  const sig = crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

// Returns the userId if state is authentic and unexpired, else null.
function verifyState(state) {
  const [payload, sig] = String(state || '').split('.');
  if (!payload || !sig) return null;
  const expectedSig = crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
  const { uid, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
  if (Date.now() > exp) return null;
  return uid;
}

module.exports = { createState, verifyState };
