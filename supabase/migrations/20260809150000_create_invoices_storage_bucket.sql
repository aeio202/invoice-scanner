-- invoices Storage bucket: holds the original PDF attachment for each saved
-- invoice row (invoices.storage_path). Private — never publicly listable or
-- fetchable by URL; every read goes through a short-lived signed URL minted
-- by the backend (GET /api/invoices/:id/download), which checks invoice
-- ownership before minting. Every write goes through the backend's
-- service-role client during POST /api/gmail/scan.
insert into storage.buckets (id, name, public)
values ('invoices', 'invoices', false)
on conflict (id) do nothing;

-- No RLS policies added here deliberately: storage.objects has RLS enabled
-- by default in every Supabase project, and with no policies for this
-- bucket, anon/authenticated get zero direct access — exactly what's
-- wanted, since 100% of access goes through the backend's service-role
-- client. Do not add a broad "authenticated" policy preemptively.
