const supabase = require('../lib/supabaseClient');
const { getClient } = require('../lib/googleOAuthClient');
const { decrypt } = require('../lib/tokenCrypto');
const { scanUserInvoices } = require('../lib/scanService');
const { ExtractionError } = require('../lib/invoiceExtraction');

// System-level job: reads every user's encrypted Gmail token. Unlike every
// other service-role query in this app (always scoped to req.user.id from an
// authenticated request), this one deliberately reads ACROSS all users —
// the one place in the codebase where that's correct, since a scheduled job
// has no single "requesting user" by definition.
async function runScanForAllUsers(months) {
  console.log(`[scan-job] starting scheduled scan at ${new Date().toISOString()}`);

  const { data: connections, error } = await supabase.from('email_connections').select('user_id, oauth_token');
  if (error) {
    console.error('[scan-job] failed to load connections:', error);
    return;
  }

  let succeeded = 0;
  let failed = 0;

  for (const connection of connections) {
    try {
      const client = getClient();
      client.setCredentials({ refresh_token: decrypt(connection.oauth_token) });
      const result = await scanUserInvoices(client, connection.user_id, months);
      succeeded += 1;
      console.log(
        `[scan-job] user ${connection.user_id}: saved=${result.saved} ` +
          `duplicates=${result.skippedDuplicate} notInvoice=${result.skippedNotInvoice} ` +
          `noPdf=${result.skippedNoPdf} errors=${result.errors}`,
      );
    } catch (err) {
      failed += 1;
      if (err instanceof ExtractionError && err.code === 'gmail_reauth_required') {
        console.error(`[scan-job] user ${connection.user_id}: Gmail access revoked — needs to reconnect. Skipping.`);
      } else {
        console.error(`[scan-job] user ${connection.user_id}: scan failed —`, err.message || err);
      }
      // Deliberately continue — one user's bad token, decrypt failure, or
      // transient error must never abort the rest of the batch. This loop
      // has no early return/throw on any per-user error, by construction.
    }
  }

  console.log(`[scan-job] finished: ${succeeded} succeeded, ${failed} failed, ${connections.length} total.`);
}

module.exports = { runScanForAllUsers };
