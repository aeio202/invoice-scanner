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
// ttlSeconds defaults to the in-app download button's 60s; the forward job
// passes a much longer TTL for its oversized-attachment fallback links.
async function createInvoiceDownloadUrl(supabase, storagePath, vendor, invoiceDate, ttlSeconds = SIGNED_URL_TTL_SECONDS) {
  const downloadName = `${sanitizeForFilename(vendor ?? 'invoice')}-${sanitizeForFilename(invoiceDate ?? '')}.pdf`;
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(storagePath, ttlSeconds, { download: downloadName });
  if (error) throw error;
  return data.signedUrl;
}

// Downloads the actual PDF bytes server-side — for attaching to an email,
// distinct from createInvoiceDownloadUrl which mints a URL for someone else
// to fetch later.
async function downloadInvoicePdfBuffer(supabase, storagePath) {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(storagePath);
  if (error) throw error;
  return Buffer.from(await data.arrayBuffer());
}

module.exports = {
  STORAGE_BUCKET,
  SIGNED_URL_TTL_SECONDS,
  storagePathFor,
  uploadInvoicePdf,
  createInvoiceDownloadUrl,
  downloadInvoicePdfBuffer,
};
