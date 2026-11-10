-- Hybrid protocol v1. Sessions are aggregates; entries and sets stay in JSONB.
-- Legacy snapshots are retained. Each account switches atomically on its first v1 RPC.
create schema if not exists workout_private;
revoke all on schema workout_private from public, anon;
grant usage on schema workout_private to authenticated;

create function workout_private.valid_session(p_id text, p_payload jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare s jsonb; e jsonb; w jsonb; metric text; n text;
begin
  if jsonb_typeof(p_payload) is distinct from 'object' then return false; end if;
  s := p_payload->'session';
  if jsonb_typeof(s) is distinct from 'object' or s->>'id' is distinct from p_id
    or jsonb_typeof(s->'id') is distinct from 'string'
    or jsonb_typeof(s->'programId') is distinct from 'string' or jsonb_typeof(s->'dayId') is distinct from 'string'
    or coalesce(s->>'programId','') = '' or coalesce(s->>'dayId','') = ''
    or coalesce(s->>'status','') not in ('draft','completed')
    or coalesce(s->>'workoutDate','') !~ '^\d{4}-\d{2}-\d{2}$'
    or jsonb_typeof(p_payload->'entries') is distinct from 'array' then return false; end if;
  if to_char((s->>'workoutDate')::date,'YYYY-MM-DD') <> s->>'workoutDate' then return false; end if;
  if coalesce(s->>'performedAt','') = '' then return false; end if;
  perform (s->>'performedAt')::timestamptz;
  if (select count(*) <> count(distinct value->>'id') or count(*) <> count(distinct value->>'slotId')
      from jsonb_array_elements(p_payload->'entries')) then return false; end if;
  for e in select value from jsonb_array_elements(p_payload->'entries') loop
    metric := e->>'metric';
    if jsonb_typeof(e) is distinct from 'object' or coalesce(e->>'id','') = ''
      or jsonb_typeof(e->'id') is distinct from 'string' or jsonb_typeof(e->'sessionId') is distinct from 'string'
      or jsonb_typeof(e->'slotId') is distinct from 'string'
      or e->>'sessionId' is distinct from p_id or coalesce(e->>'slotId','') = ''
      or coalesce(metric,'') not in ('load-reps','reps','duration')
      or jsonb_typeof(e->'sets') is distinct from 'array' then return false; end if;
    if (select count(*) <> count(distinct value->>'id') or count(*) <> count(distinct value->>'order')
        from jsonb_array_elements(e->'sets')) then return false; end if;
    for w in select value from jsonb_array_elements(e->'sets') loop
      if jsonb_typeof(w) is distinct from 'object' or coalesce(w->>'id','') = ''
        or jsonb_typeof(w->'id') is distinct from 'string' or jsonb_typeof(w->'order') is distinct from 'number'
        or coalesce(w->>'metric','') <> metric
        or coalesce(w->>'kind','') not in ('working','warmup')
        or coalesce(w->>'side','') not in ('both','left','right')
        or jsonb_typeof(w->'confirmed') is distinct from 'boolean'
        or coalesce(w->>'order','') !~ '^[1-9][0-9]*$' then return false; end if;
      foreach n in array array['loadKg','reps','durationSeconds'] loop
        if w->n is not null and w->n <> 'null'::jsonb then
          if jsonb_typeof(w->n) <> 'number' or (w->>n)::numeric < 0 then return false; end if;
          if n <> 'loadKg' and ((w->>n)::numeric <= 0 or trunc((w->>n)::numeric) <> (w->>n)::numeric) then return false; end if;
        end if;
      end loop;
      if (w->>'confirmed')::boolean then
        if metric = 'load-reps' and (w->>'loadKg' is null or w->>'reps' is null) then return false; end if;
        if metric = 'reps' and w->>'reps' is null then return false; end if;
        if metric = 'duration' and w->>'durationSeconds' is null then return false; end if;
      end if;
    end loop;
  end loop;
  return true;
exception when invalid_text_representation or datetime_field_overflow or invalid_datetime_format or numeric_value_out_of_range then
  return false;
end;
$$;

create table public.workout_sessions (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null check (length(id) > 0),
  payload jsonb not null,
  program_id text generated always as (payload #>> '{session,programId}') stored,
  status text generated always as (payload #>> '{session,status}') stored,
  workout_date date,
  performed_at timestamptz,
  format_version integer not null default 1 check (format_version = 1),
  revision bigint not null check (revision > 0),
  updated_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz,
  primary key (user_id,id),
  check (deleted_at is not null or workout_private.valid_session(id,payload))
);
create index workout_sessions_history on public.workout_sessions(user_id,performed_at desc,id) where deleted_at is null;
create index workout_sessions_entry_ids on public.workout_sessions using gin ((payload->'entries') jsonb_path_ops) where deleted_at is null;
create table public.workout_settings (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null check (length(id)>0 and id not in ('activeSessionId','currentProgramId')),
  payload jsonb not null,
  format_version integer not null default 1 check (format_version = 1),
  revision bigint not null check (revision > 0),
  updated_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz,
  primary key(user_id,id),
  check (deleted_at is not null or coalesce((jsonb_typeof(payload)='object' and payload->>'key'=id and payload ? 'value'),false))
);
alter table public.workout_sessions enable row level security;
alter table public.workout_settings enable row level security;
create policy workout_sessions_read_own on public.workout_sessions for select to authenticated using ((select auth.uid())=user_id);
create policy workout_settings_read_own on public.workout_settings for select to authenticated using ((select auth.uid())=user_id);
-- CAS, validation and idempotency cannot be bypassed by direct REST writes.
revoke all on public.workout_sessions, public.workout_settings from public, anon, authenticated;
grant select on public.workout_sessions, public.workout_settings to authenticated;

create table workout_private.protocol_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  migrated_at timestamptz not null default clock_timestamp()
);
create table workout_private.operation_receipts (
  user_id uuid not null references auth.users(id) on delete cascade,
  operation_id uuid not null,
  request_hash text not null,
  revision bigint not null,
  updated_at timestamptz not null,
  primary key(user_id,operation_id)
);
alter table workout_private.protocol_users enable row level security;
alter table workout_private.operation_receipts enable row level security;
revoke all on workout_private.protocol_users,workout_private.operation_receipts from public,anon,authenticated;
create policy protocol_users_deny_direct_access on workout_private.protocol_users for all to authenticated using (false) with check (false);
create policy operation_receipts_deny_direct_access on workout_private.operation_receipts for all to authenticated using (false) with check (false);

create function workout_private.ensure_account()
returns void language plpgsql security definer set search_path='' as $$
declare owner uuid := auth.uid(); old public.workout_snapshots%rowtype; s jsonb; setting jsonb; bundle jsonb;
begin
  if owner is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if exists(select 1 from workout_private.protocol_users where user_id=owner) then return; end if;
  perform pg_advisory_xact_lock(hashtext(owner::text),hashtext('workout-protocol'));
  if exists(select 1 from workout_private.protocol_users where user_id=owner) then return; end if;
  select * into old from public.workout_snapshots where user_id=owner for update;
  if found then
    if jsonb_typeof(old.snapshot->'sessions') is distinct from 'array'
      or jsonb_typeof(old.snapshot->'entries') is distinct from 'array'
      or jsonb_typeof(old.snapshot->'settings') is distinct from 'array' then
      raise exception 'Invalid legacy snapshot; original data retained' using errcode='22023';
    end if;
    if exists(select 1 from jsonb_array_elements(old.snapshot->'entries') as legacy_entry(value) where not exists
      (select 1 from jsonb_array_elements(old.snapshot->'sessions') as legacy_session(value) where legacy_session.value->>'id'=legacy_entry.value->>'sessionId'))
      or (select count(*)<>count(distinct value->>'id') from jsonb_array_elements(old.snapshot->'entries')) then
      raise exception 'Invalid legacy relationships; original data retained' using errcode='22023';
    end if;
    for s in select value from jsonb_array_elements(old.snapshot->'sessions') loop
      select jsonb_build_object('session',s,'entries',coalesce(jsonb_agg(e order by e->>'id'),'[]'::jsonb)) into bundle
      from jsonb_array_elements(old.snapshot->'entries') e where e->>'sessionId'=s->>'id';
      insert into public.workout_sessions(user_id,id,payload,revision,workout_date,performed_at,updated_at)
      values(owner,s->>'id',bundle,old.revision,(s->>'workoutDate')::date,(s->>'performedAt')::timestamptz,old.updated_at);
    end loop;
    for setting in select value from jsonb_array_elements(old.snapshot->'settings') loop
      if setting->>'key' in ('activeSessionId','currentProgramId') then continue; end if;
      if setting->>'key'='cloudLegacyImportV1' and jsonb_typeof(setting->'value')='object' and setting->'value' ? 'fingerprint' then
        setting := setting || jsonb_build_object('value',(setting->'value'-'fingerprint') ||
          jsonb_build_object('digest',encode(extensions.digest(setting#>>'{value,fingerprint}','sha256'),'hex')));
      end if;
      insert into public.workout_settings(user_id,id,payload,revision,updated_at)
      values(owner,setting->>'key',setting,old.revision,old.updated_at);
    end loop;
  end if;
  insert into workout_private.protocol_users(user_id) values(owner);
end;
$$;

create function workout_private.protect_legacy_snapshot()
returns trigger language plpgsql security definer set search_path='' as $$
declare owner uuid := case when tg_op='DELETE' then old.user_id else new.user_id end;
begin
  perform pg_advisory_xact_lock(hashtext(owner::text),hashtext('workout-protocol'));
  if exists(select 1 from workout_private.protocol_users where user_id=owner)
    and exists(select 1 from auth.users where id=owner) then
    raise exception 'Оновіть застосунок: акаунт використовує збереження окремих тренувань' using errcode='55000';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
create trigger workout_snapshot_protocol_guard before insert or update or delete on public.workout_snapshots
for each row execute function workout_private.protect_legacy_snapshot();

create function workout_private.current_record(p_kind text,p_id text)
returns jsonb language sql stable set search_path='' as $$
  select to_jsonb(r) from (
    select 'session'::text kind,id,payload,format_version,revision,updated_at,deleted_at
      from public.workout_sessions where user_id=auth.uid() and id=p_id and p_kind='session'
    union all
    select 'setting',id,payload,format_version,revision,updated_at,deleted_at
      from public.workout_settings where user_id=auth.uid() and id=p_id and p_kind='setting'
  ) r;
$$;

create function workout_private.get_changes(p_versions jsonb,p_keys text[])
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  perform workout_private.ensure_account();
  if jsonb_typeof(p_versions) is distinct from 'object' then raise exception 'Invalid version map' using errcode='22023'; end if;
  select coalesce(jsonb_agg(to_jsonb(r) order by kind,id),'[]'::jsonb) into result from (
    select 'session'::text kind,id,payload,format_version,revision,updated_at,deleted_at
      from public.workout_sessions where user_id=auth.uid()
    union all
    select 'setting',id,payload,format_version,revision,updated_at,deleted_at
      from public.workout_settings where user_id=auth.uid()
  ) r where revision > coalesce((p_versions->>(kind||':'||id))::bigint,0)
    and (p_keys is null or (kind||':'||id)=any(p_keys));
  return result;
end;
$$;

create function workout_private.apply_change(p_operation_id uuid,p_kind text,p_id text,p_expected_revision bigint,p_format_version integer,p_payload jsonb,p_deleted boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare owner uuid := auth.uid(); current jsonb; receipt workout_private.operation_receipts%rowtype;
  request_hash text; next_revision bigint; changed_at timestamptz := clock_timestamp();
begin
  perform workout_private.ensure_account();
  if p_operation_id is null or p_kind not in ('session','setting') or p_kind is null or coalesce(p_id,'')=''
    or p_expected_revision is null or p_expected_revision<0 or p_deleted is null or p_format_version is distinct from 1 then
    raise exception 'Unsupported workout format or invalid operation' using errcode='22023';
  end if;
  -- Short per-owner transaction lock also protects entry ID uniqueness across aggregates.
  perform pg_advisory_xact_lock(hashtext(owner::text),hashtext('workout-write'));
  request_hash := encode(extensions.digest(jsonb_build_array(p_kind,p_id,p_expected_revision,p_format_version,p_payload,p_deleted)::text,'sha256'),'hex');
  select * into receipt from workout_private.operation_receipts where user_id=owner and operation_id=p_operation_id;
  if found then
    if receipt.request_hash<>request_hash then raise exception 'Operation ID reused for another request' using errcode='22023'; end if;
    return jsonb_build_object('status','applied','revision',receipt.revision,'updated_at',receipt.updated_at);
  end if;
  current := workout_private.current_record(p_kind,p_id);
  if coalesce((current->>'revision')::bigint,0)<>p_expected_revision then
    return jsonb_build_object('status','conflict','record',current);
  end if;
  next_revision := p_expected_revision+1;
  if p_kind='session' then
    if not p_deleted and not workout_private.valid_session(p_id,p_payload) then raise exception 'Invalid workout payload' using errcode='22023'; end if;
    if not p_deleted and exists (
      select 1 from jsonb_array_elements(p_payload->'entries') e join public.workout_sessions s
      on s.user_id=owner and s.id<>p_id and s.deleted_at is null
      and (s.payload->'entries') @> jsonb_build_array(jsonb_build_object('id',e->>'id'))
    ) then raise exception 'Entry ID already belongs to another workout' using errcode='23505'; end if;
    insert into public.workout_sessions(user_id,id,payload,revision,updated_at,deleted_at,workout_date,performed_at)
    values(owner,p_id,case when p_deleted then '{}'::jsonb else p_payload end,next_revision,changed_at,
      case when p_deleted then changed_at end,case when not p_deleted then (p_payload#>>'{session,workoutDate}')::date end,
      case when not p_deleted then (p_payload#>>'{session,performedAt}')::timestamptz end)
    on conflict(user_id,id) do update set payload=excluded.payload,revision=excluded.revision,updated_at=excluded.updated_at,
      deleted_at=excluded.deleted_at,workout_date=excluded.workout_date,performed_at=excluded.performed_at;
  else
    if p_id in ('activeSessionId','currentProgramId') then raise exception 'Device setting cannot be synchronized' using errcode='22023'; end if;
    if not p_deleted and (jsonb_typeof(p_payload) is distinct from 'object' or p_payload->>'key' is distinct from p_id or not p_payload ? 'value') then
      raise exception 'Invalid setting payload' using errcode='22023';
    end if;
    insert into public.workout_settings(user_id,id,payload,revision,updated_at,deleted_at)
    values(owner,p_id,case when p_deleted then '{}'::jsonb else p_payload end,next_revision,changed_at,case when p_deleted then changed_at end)
    on conflict(user_id,id) do update set payload=excluded.payload,revision=excluded.revision,updated_at=excluded.updated_at,deleted_at=excluded.deleted_at;
  end if;
  insert into workout_private.operation_receipts values(owner,p_operation_id,request_hash,next_revision,changed_at);
  return jsonb_build_object('status','applied','revision',next_revision,'updated_at',changed_at);
end;
$$;

-- Privileged implementation stays outside exposed schemas. Ownership derives from auth.uid();
-- the expected ID below only binds an in-flight request to its local account queue.
revoke all on all functions in schema workout_private from public,anon,authenticated;
grant execute on function workout_private.get_changes(jsonb,text[]),workout_private.apply_change(uuid,text,text,bigint,integer,jsonb,boolean) to authenticated;
create function public.workout_get_changes(p_expected_user_id uuid,p_versions jsonb default '{}'::jsonb,p_keys text[] default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
begin
  if auth.uid() is null or auth.uid() is distinct from p_expected_user_id then raise exception 'Account changed; restart synchronization' using errcode='42501'; end if;
  return workout_private.get_changes(p_versions,p_keys);
end;
$$;
create function public.workout_apply_change(p_expected_user_id uuid,p_operation_id uuid,p_kind text,p_id text,p_expected_revision bigint,p_format_version integer,p_payload jsonb,p_deleted boolean)
returns jsonb language plpgsql security invoker set search_path='' as $$
begin
  if auth.uid() is null or auth.uid() is distinct from p_expected_user_id then raise exception 'Account changed; restart synchronization' using errcode='42501'; end if;
  return workout_private.apply_change(p_operation_id,p_kind,p_id,p_expected_revision,p_format_version,p_payload,p_deleted);
end;
$$;
revoke all on function public.workout_get_changes(uuid,jsonb,text[]),public.workout_apply_change(uuid,uuid,text,text,bigint,integer,jsonb,boolean) from public,anon;
grant execute on function public.workout_get_changes(uuid,jsonb,text[]),public.workout_apply_change(uuid,uuid,text,text,bigint,integer,jsonb,boolean) to authenticated;
