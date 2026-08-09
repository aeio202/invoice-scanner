-- forward_jobs table: tracks each monthly invoice-forwarding email sent to a
-- user's configured accountant_email (SPEC.md §4). One row per (user,
-- period) — the unique constraint below is the mechanism that prevents
-- double-sending the same period's digest.
create table public.forward_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  period text not null,               -- 'YYYY-MM', the calendar month this digest covers
  recipient_email text not null,      -- snapshot of accountant_email at send time
  invoice_ids uuid[] not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  scheduled_at timestamptz not null default now(),
  sent_at timestamptz,
  error_message text,
  unique (user_id, period)
);

comment on table public.forward_jobs is
  'One row per (user, period) monthly invoice-forwarding attempt (SPEC.md '
  '§4). unique(user_id, period) is the double-send guard: '
  'backend/src/jobs/forwardInvoices.js inserts a pending row FIRST, before '
  'attempting to send — a second attempt for the same period hits this '
  'constraint and is treated as "already attempted, skip." period, '
  'scheduled_at, sent_at, and error_message go beyond SPEC §4''s literal '
  'column list — needed to actually implement double-send prevention and '
  'auditable failure tracking, not just store an opaque status string.';

alter table public.forward_jobs enable row level security;

create policy "forward_jobs_select_own"
  on public.forward_jobs
  for select
  to authenticated
  using (user_id = auth.uid());
-- No insert/update/delete policy for authenticated — same pattern as every
-- other backend-managed table; all writes happen via the scheduled job's
-- service-role client.

grant usage on schema public to authenticated, service_role;
grant select on public.forward_jobs to authenticated;
grant select, insert, update, delete on public.forward_jobs to service_role;
