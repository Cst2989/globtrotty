-- supabase/ci-bootstrap.sql — what a bare Postgres lacks that the migrations assume.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;

-- Supabase's auth.uid() reads the JWT claim GoTrue sets per request. A bare Postgres
-- has no auth schema, so policies referencing auth.uid() would fail to CREATE. This
-- stub returns NULL (no session) so the migrations apply and the owner-connected
-- tests are unaffected; the real isolation test runs against Supabase only.
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
