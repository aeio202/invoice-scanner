-- email_connections table: stores the encrypted Gmail OAuth refresh token per user
-- (SPEC.md §4). One row per user (single Gmail connection per account, MVP scope).
-- oauth_token is AES-256-GCM ciphertext produced by backend/src/lib/tokenCrypto.js
-- BEFORE the row is ever written — Postgres never sees the plaintext refresh token.
-- All writes happen through the backend's service-role Supabase client
-- (backend/src/lib/supabaseClient.js), which bypasses RLS; every write must set
-- user_id explicitly and every read filter by it manually. See that file's comment.

create table public.email_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  oauth_token text not null,
  scope text not null,
  connected_at timestamptz not null default now(),
  last_scan_at timestamptz,
  unique (user_id)
);

comment on table public.email_connections is
  'Encrypted Gmail OAuth refresh token per user (SPEC.md §4). oauth_token is '
  'AES-256-GCM ciphertext encrypted in backend/src/lib/tokenCrypto.js before '
  'insert — never plaintext at rest. unique(user_id): one active Gmail '
  'connection per account (MVP). Written only via the backend service-role '
  'client; see backend/src/lib/supabaseClient.js for the RLS-bypass caveat.';

comment on column public.email_connections.oauth_token is
  'AES-256-GCM ciphertext ("v1:<iv_b64>:<tag_b64>:<ciphertext_b64>"), never '
  'the plaintext Google refresh token. Decrypt only in the backend via '
  'tokenCrypto.decrypt(), never in a client/browser context.';

alter table public.email_connections enable row level security;

-- authenticated may only READ their own row — no insert/update/delete policy.
-- All writes go through the backend's service-role client, which performs
-- encryption before writing. Granting authenticated write access here would
-- let a client overwrite oauth_token with unencrypted garbage, defeating the
-- encryption invariant, for no legitimate use case (unlike `users`, nothing
-- about this row is meant to be user-editable).
create policy "email_connections_select_own"
  on public.email_connections
  for select
  to authenticated
  using (user_id = auth.uid());

-- Explicit GRANTs. RLS policies only *restrict rows* — they do not *grant*
-- table access. A freshly created table has no privileges for
-- authenticated/service_role until explicitly granted; this is the gap that
-- caused the permission error on the `users` table migration (RLS policies
-- existed there, but no GRANT statements). Do not repeat that here.
grant usage on schema public to authenticated, service_role;
grant select on public.email_connections to authenticated;
grant select, insert, update, delete on public.email_connections to service_role;
