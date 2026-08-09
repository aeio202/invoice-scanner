const { Resend } = require('resend');
const { downloadInvoicePdfBuffer, createInvoiceDownloadUrl } = require('./invoiceStorage');

const FROM_ADDRESS = process.env.RESEND_FROM_ADDRESS || 'Invoice Scanner <onboarding@resend.dev>';

// Lazily constructed: the Resend constructor throws immediately if no API
// key is set, and this module is required at boot (via scheduler.js) even
// when forwarding is never used — a missing RESEND_API_KEY must not crash
// the whole backend on startup, only the actual send attempt.
let resend = null;
function getResendClient() {
  if (!resend) resend = new Resend(process.env.RESEND_API_KEY);
  return resend;
}

// AI-extracted vendor names are untrusted content — escaped before going into
// the digest HTML, same discipline as the dashboard's textContent-only
// rendering.
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatAmount(inv) {
  return inv.amount != null && inv.currency ? `${inv.amount.toFixed(2)} ${inv.currency}` : '—';
}

// Builds the digest HTML. `links` is an optional Map<invoiceId, url> — only
// populated (and only rendered) in the oversized-attachments fallback path.
function buildDigestHtml(period, userEmail, invoices, links) {
  const rows = invoices
    .map((inv) => {
      const linkCell = links ? `<td>${links.has(inv.id) ? `<a href="${links.get(inv.id)}">Download</a>` : '—'}</td>` : '';
      return `<tr><td>${escapeHtml(inv.vendor ?? '(unknown)')}</td><td>${formatAmount(inv)}</td><td>${inv.invoice_date ?? '—'}</td>${linkCell}</tr>`;
    })
    .join('');
  const linkHeader = links ? '<th>PDF</th>' : '';
  const note = links
    ? '<p>PDFs for this period were too large to attach directly — download links are included above, valid for 7 days.</p>'
    : '';
  return `<h2>Invoices for ${period} — ${escapeHtml(userEmail)}</h2>
    <table border="1" cellpadding="6" cellspacing="0">
      <thead><tr><th>Vendor</th><th>Amount</th><th>Date</th>${linkHeader}</tr></thead>
      <tbody>${rows}</tbody>
    </table>${note}`;
}

const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024; // safety margin under Resend's 40MB post-encoding cap
const FALLBACK_LINK_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

async function sendInvoiceDigest(supabase, { recipientEmail, userEmail, period, invoices }) {
  const withPdf = invoices.filter((inv) => inv.storage_path);
  const downloads = await Promise.all(
    withPdf.map(async (inv) => ({ inv, buffer: await downloadInvoicePdfBuffer(supabase, inv.storage_path) })),
  );
  const totalBytes = downloads.reduce((sum, d) => sum + d.buffer.length, 0);

  let attachments = [];
  let links = null;
  if (totalBytes <= MAX_ATTACHMENT_BYTES) {
    attachments = downloads.map(({ inv, buffer }) => ({
      filename: `${(inv.vendor ?? 'invoice').replace(/[^\w.-]+/g, '_')}-${inv.invoice_date ?? ''}.pdf`,
      content: buffer,
    }));
  } else {
    links = new Map(
      await Promise.all(
        withPdf.map(async (inv) => [
          inv.id,
          await createInvoiceDownloadUrl(supabase, inv.storage_path, inv.vendor, inv.invoice_date, FALLBACK_LINK_TTL_SECONDS),
        ]),
      ),
    );
  }

  const { error } = await getResendClient().emails.send({
    from: FROM_ADDRESS,
    to: recipientEmail,
    subject: `Invoices for ${period} — ${userEmail}`,
    html: buildDigestHtml(period, userEmail, invoices, links),
    attachments,
  });
  if (error) throw new Error(error.message || 'Resend send failed');
}

module.exports = { sendInvoiceDigest };
