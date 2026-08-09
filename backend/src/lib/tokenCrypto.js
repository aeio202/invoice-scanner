const crypto = require('crypto');

function getKey() {
  const raw = process.env.GMAIL_TOKEN_ENCRYPTION_KEY;
  if (!raw) throw new Error('GMAIL_TOKEN_ENCRYPTION_KEY is not set');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('GMAIL_TOKEN_ENCRYPTION_KEY must base64-decode to 32 bytes (AES-256)');
  }
  return key;
}

// Encrypts a plaintext string (a Gmail refresh token) for storage in
// email_connections.oauth_token. AES-256-GCM: iv is random per call, tag
// provides integrity (tamper-evident, not just confidentiality).
function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

function decrypt(stored) {
  const [version, ivB64, tagB64, ctB64] = stored.split(':');
  if (version !== 'v1') throw new Error(`Unsupported oauth_token format: ${version}`);
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
