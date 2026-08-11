const supabase = require('../lib/supabaseClient');
const { sendInvoiceDigest } = require('../lib/emailService');

function previousMonthPeriod(referenceDate = new Date()) {
  const d = new Date(Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth(), 1));
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7); // "YYYY-MM"
}

function nextMonthStart(period) {
  const [year, month] = period.split('-').map(Number); // month is 1-indexed in "YYYY-MM"
  return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10); // JS Date month is 0-indexed, so `month` here IS next month
}

// Single-user forwarding attempt for one period. Shared by the all-users cron
// loop below and the on-demand /api/forward/now route — the double-send
// guard (insert forward_jobs BEFORE sending, rely on the unique constraint)
// only protects against duplicate sends if every caller goes through this one
// function instead of reimplementing the sequence.
async function forwardInvoicesForUser(user, period) {
  const { data: invoices, error: invErr } = await supabase
    .from('invoices')
    .select('id, vendor, amount, currency, invoice_date, storage_path')
    .eq('user_id', user.id)
    .eq('status', 'confirmed')
    .gte('invoice_date', `${period}-01`)
    .lt('invoice_date', nextMonthStart(period));
  if (invErr) throw invErr;

  if (!invoices || invoices.length === 0) {
    return { status: 'no_invoices' };
  }

  // Reserve this (user, period) FIRST — before sending anything. If this
  // insert hits the unique constraint, a job for this period already exists
  // (sent or failed) and must not be attempted again.
  const { data: job, error: insertErr } = await supabase
    .from('forward_jobs')
    .insert({
      user_id: user.id,
      period,
      recipient_email: user.accountant_email,
      invoice_ids: invoices.map((i) => i.id),
      status: 'pending',
    })
    .select('id')
    .maybeSingle();

  if (insertErr) {
    if (insertErr.code === '23505') {
      return { status: 'already_sent' };
    }
    throw insertErr;
  }

  try {
    await sendInvoiceDigest(supabase, { recipientEmail: user.accountant_email, userEmail: user.email, period, invoices });
    await supabase.from('forward_jobs').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', job.id);
    return { status: 'sent', count: invoices.length };
  } catch (sendErr) {
    await supabase.from('forward_jobs').update({ status: 'failed', error_message: sendErr.message }).eq('id', job.id);
    throw sendErr;
  }
}

// System-level job: reads every user with a configured accountant_email —
// same "no single requesting user" reasoning as the scan job's cross-user
// query. Never sends anything for a user who hasn't explicitly set a
// recipient (the accountant_email filter below is what makes that true).
async function runForwardForAllUsers(period = previousMonthPeriod()) {
  console.log(`[forward-job] starting forward run for period ${period} at ${new Date().toISOString()}`);

  const { data: users, error } = await supabase
    .from('users')
    .select('id, email, accountant_email')
    .not('accountant_email', 'is', null);
  if (error) {
    console.error('[forward-job] failed to load users:', error);
    return;
  }

  let sent = 0;
  let skippedNoInvoices = 0;
  let skippedAlreadySent = 0;
  let failed = 0;

  for (const user of users) {
    try {
      const result = await forwardInvoicesForUser(user, period);
      if (result.status === 'sent') {
        sent += 1;
        console.log(`[forward-job] user ${user.id}: sent digest for ${period} (${result.count} invoices) to ${user.accountant_email}`);
      } else if (result.status === 'no_invoices') {
        skippedNoInvoices += 1;
      } else if (result.status === 'already_sent') {
        skippedAlreadySent += 1;
      }
    } catch (err) {
      failed += 1;
      console.error(`[forward-job] user ${user.id}: failed —`, err.message || err);
      // Deliberately continue — same per-user isolation as the scan job.
    }
  }

  console.log(
    `[forward-job] finished period ${period}: sent=${sent} noInvoices=${skippedNoInvoices} ` +
      `alreadySent=${skippedAlreadySent} failed=${failed} totalUsers=${users.length}`,
  );
}

module.exports = { runForwardForAllUsers, forwardInvoicesForUser, previousMonthPeriod };
