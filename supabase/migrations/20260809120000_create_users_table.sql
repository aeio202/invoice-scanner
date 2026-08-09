-- users table: mirror of auth.users, FK target for email_connections/invoices/forward_jobs
-- (SPEC.md §4). Rows are created automatically by the on_auth_user_created trigger below;
-- never insert into this table directly from application code.

create table public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique,
  created_at timestamptz not null default now()
);

comment on table public.users is
  'Mirror of auth.users, used as the FK target for user-owned tables '
  '(email_connections, invoices, forward_jobs — SPEC.md §4). Rows are created '
  'automatically by the on_auth_user_created trigger; never insert into this '
  'table directly from application code.';

-- SECURITY DEFINER: runs as the function owner (not the signing-up user, who has no
-- session yet), so it can bypass RLS to write the row. search_path is pinned to '' and
-- every reference is schema-qualified to avoid the classic search_path-hijacking footgun
-- for SECURITY DEFINER functions (a lower-privileged role shadowing an unqualified name
-- with an object in `public`).
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.users (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

alter table public.users enable row level security;

create policy "users_select_own"
  on public.users
  for select
  to authenticated
  using (id = auth.uid());

create policy "users_update_own"
  on public.users
  for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- No INSERT/DELETE policy for `authenticated` — denied by default. INSERT only happens
-- via the SECURITY DEFINER trigger above (bypasses RLS by ownership, not by policy).
-- DELETE (account/GDPR erasure) is a future slice with its own reviewed flow.
