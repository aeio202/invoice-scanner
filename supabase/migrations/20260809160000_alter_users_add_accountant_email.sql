-- Adds accountant_email to public.users — where the recipient for automatic
-- invoice forwarding is configured (SPEC.md §1's "centralized package to an
-- email address specified by the client"). Nullable: forwarding stays fully
-- inert for a user until they explicitly set this — see the accountant_email
-- IS NOT NULL filter in backend/src/jobs/forwardInvoices.js.
alter table public.users add column accountant_email text;

comment on column public.users.accountant_email is
  'Recipient for the automatic monthly invoice-forwarding digest (SPEC.md '
  '§1/§4). Null by default — forwarding never runs for a user who has not '
  'explicitly set this, by design.';

-- Retrofit: this table's original migration (20260809120000) had RLS
-- policies but no explicit GRANT statements — the exact gap that later
-- motivated this project's "always add GRANTs" convention, first applied to
-- email_connections. It went unnoticed here because no backend code ever
-- queried public.users directly until now (GET/PATCH /api/me needs it).
-- Closing it now rather than leaving it latent.
grant usage on schema public to authenticated, service_role;
grant select, update on public.users to authenticated;
grant select, insert, update, delete on public.users to service_role;
