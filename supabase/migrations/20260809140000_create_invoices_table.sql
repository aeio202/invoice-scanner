-- invoices table: extracted invoice/receipt data per user (SPEC.md §4).
-- storage_path stays null/unused until the PDF-upload-to-Storage slice.
-- category stays null until a future categorization slice populates it
-- (deterministic vendor matching + AI fallback, per SPEC.md §3.6) — no
-- vendor knowledge base exists yet to categorize against.

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  vendor text,
  amount numeric,
  currency text check (currency is null or char_length(currency) = 3),
  invoice_date date,
  category text,
  status text not null default 'needs_review' check (status in ('confirmed', 'needs_review')),
  source text not null default 'attachment' check (source in ('attachment', 'body')),
  storage_path text,
  dedup_hash text,
  created_at timestamptz not null default now()
);

comment on table public.invoices is
  'Extracted invoice/receipt data per user (SPEC.md §4). Written only via the '
  'backend service-role client (see backend/src/lib/supabaseClient.js). '
  'status=needs_review when any of vendor/amount/currency/invoice_date could '
  'not be confidently extracted; confirmed when all four are present.';

comment on column public.invoices.dedup_hash is
  'sha256(normalized vendor + "|" + exact invoice_date + "|" + amount), '
  'computed by the backend before insert '
  '(backend/src/lib/invoiceExtraction.js). Deliberately NOT truncated to a '
  'month — that would collide two distinct invoices from the same vendor in '
  'the same month. Null when vendor, invoice_date, or amount could not be '
  'determined — such rows are never deduped against each other (see the '
  'partial unique index below).';

-- Partial unique index: uniqueness is only enforced when we actually have
-- enough information to dedup (vendor+date+amount all present, so
-- dedup_hash is non-null). A needs_review row with a null hash can coexist
-- with any number of other null-hash rows for the same user — nothing to
-- compare them on.
create unique index invoices_user_dedup_hash_key
  on public.invoices (user_id, dedup_hash)
  where dedup_hash is not null;

alter table public.invoices enable row level security;

-- authenticated may only READ their own rows — no insert/update/delete
-- policy. All writes go through the backend's service-role client (same
-- pattern as email_connections). A future slice may add an update policy
-- once "mark as confirmed" becomes a user-facing action.
create policy "invoices_select_own"
  on public.invoices
  for select
  to authenticated
  using (user_id = auth.uid());

-- Explicit GRANTs from the start (the users/email_connections lesson: RLS
-- policies restrict rows, they do not grant table access).
grant usage on schema public to authenticated, service_role;
grant select on public.invoices to authenticated;
grant select, insert, update, delete on public.invoices to service_role;
