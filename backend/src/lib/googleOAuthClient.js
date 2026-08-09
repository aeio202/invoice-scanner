const { OAuth2Client } = require('google-auth-library');

const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

function getClient() {
  return new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GMAIL_OAUTH_REDIRECT_URI,
  );
}

function getAuthUrl(state) {
  return getClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // forces refresh_token reissue on reconnect too
    scope: [GMAIL_READONLY_SCOPE],
    state,
  });
}

async function exchangeCode(code) {
  const { tokens } = await getClient().getToken(code);
  return tokens; // { refresh_token, access_token, scope, expiry_date, ... }
}

module.exports = { getAuthUrl, exchangeCode, GMAIL_READONLY_SCOPE };
