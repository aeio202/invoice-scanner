const express = require('express');
const supabase = require('../lib/supabaseClient');
const { createInvoiceDownloadUrl } = require('../lib/invoiceStorage');

const router = express.Router();

router.get('/:id/download', async (req, res) => {
  // Service-role read: bypasses RLS — must filter by user_id manually. This
  // is the ownership check that makes it safe to mint a signed URL below;
  // without it, any authenticated user could request any invoice_id's PDF.
  const { data: invoice, error } = await supabase
    .from('invoices')
    .select('storage_path, vendor, invoice_date')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: 'Failed to load invoice' });
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  if (!invoice.storage_path) {
    return res.status(404).json({ error: 'no_pdf_available', message: 'No PDF is stored for this invoice.' });
  }

  try {
    const url = await createInvoiceDownloadUrl(supabase, invoice.storage_path, invoice.vendor, invoice.invoice_date);
    res.json({ url, expiresInSeconds: 60 });
  } catch (err) {
    console.error('Failed to create signed URL:', err);
    res.status(502).json({ error: 'Failed to create download link' });
  }
});

module.exports = router;
