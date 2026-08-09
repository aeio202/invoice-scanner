const express = require('express');
const supabase = require('../lib/supabaseClient');

const router = express.Router();
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.get('/', async (req, res) => {
  // Service-role read: bypasses RLS — must filter by id manually.
  const { data, error } = await supabase
    .from('users')
    .select('accountant_email')
    .eq('id', req.user.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: 'Failed to load profile' });
  res.json({ id: req.user.id, email: req.user.email, accountantEmail: data?.accountant_email ?? null });
});

router.patch('/', async (req, res) => {
  const { accountantEmail } = req.body || {};
  if (accountantEmail !== null && accountantEmail !== undefined && !EMAIL_PATTERN.test(accountantEmail)) {
    return res.status(400).json({ error: 'invalid_email', message: 'accountantEmail must be a valid email address or null.' });
  }
  // Service-role write: bypasses RLS — must filter by id manually.
  const { error } = await supabase
    .from('users')
    .update({ accountant_email: accountantEmail ?? null })
    .eq('id', req.user.id);
  if (error) return res.status(500).json({ error: 'Failed to update profile' });
  res.json({ accountantEmail: accountantEmail ?? null });
});

module.exports = router;
