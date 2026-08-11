const express = require('express');
const supabase = require('../lib/supabaseClient');
const { forwardInvoicesForUser } = require('../jobs/forwardInvoices');

const router = express.Router();
const PERIOD_PATTERN = /^\d{4}-\d{2}$/;

router.post('/now', async (req, res) => {
  const { period } = req.body || {};
  if (typeof period !== 'string' || !PERIOD_PATTERN.test(period)) {
    return res.status(400).json({ error: 'invalid_period', message: 'period must be in YYYY-MM format.' });
  }

  // Service-role read: bypasses RLS — must filter by id manually. Checked
  // server-side (not just a disabled button) so a forged request can't
  // trigger a send for a user who never set a recipient.
  const { data: user, error: userErr } = await supabase
    .from('users')
    .select('id, email, accountant_email')
    .eq('id', req.user.id)
    .maybeSingle();
  if (userErr) return res.status(500).json({ error: 'Failed to load profile' });
  if (!user?.accountant_email) {
    return res.status(400).json({ error: 'no_accountant_email', message: 'Set an accountant email before forwarding.' });
  }

  try {
    const result = await forwardInvoicesForUser(user, period);
    if (result.status === 'sent') {
      return res.json({ status: 'sent', count: result.count });
    }
    if (result.status === 'already_sent') {
      return res.status(409).json({ status: 'already_sent', message: `A digest for ${period} was already sent.` });
    }
    return res.json({ status: 'no_invoices', message: `No confirmed invoices for ${period}.` });
  } catch (err) {
    console.error(`Forward-now failed for user ${req.user.id}, period ${period}:`, err.message || err);
    return res.status(502).json({ status: 'failed', message: 'Failed to send digest.' });
  }
});

module.exports = router;
