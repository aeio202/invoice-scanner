const STORAGE_BUCKET = 'invoices';
const SIGNED_URL_TTL_SECONDS = 60;

// {user_id}/{invoice_id}.pdf — one prefix per user, so "delete everything for
// this user" (SPEC.md §5's GDPR requirement) is a single prefix-based Storage
// operation. Deliberately opaque: no vendor name or original filename in the
// path itself, so the storage key doesn't leak PII on its own.
function storagePathFor(userId, invoiceId) {
  return `${userId}/${invoiceId}.pdf`;
}

async function uploadInvoicePdf(supabase, userId, invoiceId, pdfBuffer) {
  const path = storagePathFor(userId, invoiceId);
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(path, pdfBuffer, { contentType: 'application/pdf', upsert: false });
  if (error) throw error;
  return path;
}

function sanitizeForFilename(value) {
  return String(value).replace(/[^\w.-]+/g, '_');
}

// Mints a short-lived signed URL for a private bucket object. The download
// filename is derived from the invoice's own vendor/date columns rather than
// stored separately, so no new invoices column is needed just for this.
async function createInvoiceDownloadUrl(supabase, storagePath, vendor, invoiceDate) {
  const downloadName = `${sanitizeForFilename(vendor ?? 'invoice')}-${sanitizeForFilename(invoiceDate ?? '')}.pdf`;
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS, { download: downloadName });
  if (error) throw error;
  return data.signedUrl;
}

module.exports = {
  STORAGE_BUCKET,
  SIGNED_URL_TTL_SECONDS,
  storagePathFor,
  uploadInvoicePdf,
  createInvoiceDownloadUrl,
};
