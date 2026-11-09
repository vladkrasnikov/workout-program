-- Run in the Supabase SQL editor. Client code must use only a publishable/anon key.
create table if not exists public.workout_snapshots (
  user_id uuid primary key references auth.users(id) on delete cascade,
  snapshot jsonb not null default '{"sessions":[],"entries":[],"settings":[]}'::jsonb,
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now()
);

alter table public.workout_snapshots enable row level security;

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.workout_snapshots to authenticated;
revoke all on public.workout_snapshots from anon;

drop policy if exists "workout_snapshots_select_own" on public.workout_snapshots;
create policy "workout_snapshots_select_own"
on public.workout_snapshots for select to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "workout_snapshots_insert_own" on public.workout_snapshots;
create policy "workout_snapshots_insert_own"
on public.workout_snapshots for insert to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "workout_snapshots_update_own" on public.workout_snapshots;
create policy "workout_snapshots_update_own"
on public.workout_snapshots for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "workout_snapshots_delete_own" on public.workout_snapshots;
create policy "workout_snapshots_delete_own"
on public.workout_snapshots for delete to authenticated
using ((select auth.uid()) = user_id);
