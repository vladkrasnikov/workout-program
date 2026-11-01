-- Run in the Supabase SQL editor. Client code must use only a publishable/anon key.
create table if not exists public.workout_snapshots (
  user_id uuid primary key references auth.users(id) on delete cascade,
  snapshot jsonb not null default '{"sessions":[],"entries":[],"settings":[]}'::jsonb,
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now()
);

alter table public.workout_snapshots enable row level security;

drop policy if exists "workout_snapshots_select_own" on public.workout_snapshots;
create policy "workout_snapshots_select_own"
on public.workout_snapshots for select
using (auth.uid() is not null and auth.uid() = user_id);

drop policy if exists "workout_snapshots_insert_own" on public.workout_snapshots;
create policy "workout_snapshots_insert_own"
on public.workout_snapshots for insert
with check (auth.uid() is not null and auth.uid() = user_id);

drop policy if exists "workout_snapshots_update_own" on public.workout_snapshots;
create policy "workout_snapshots_update_own"
on public.workout_snapshots for update
using (auth.uid() is not null and auth.uid() = user_id)
with check (auth.uid() is not null and auth.uid() = user_id);

drop policy if exists "workout_snapshots_delete_own" on public.workout_snapshots;
create policy "workout_snapshots_delete_own"
on public.workout_snapshots for delete
using (auth.uid() is not null and auth.uid() = user_id);
