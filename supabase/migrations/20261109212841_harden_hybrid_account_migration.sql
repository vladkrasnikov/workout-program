create or replace function workout_private.ensure_account()
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
create policy protocol_users_deny_direct_access on workout_private.protocol_users for all to authenticated using (false) with check (false);
create policy operation_receipts_deny_direct_access on workout_private.operation_receipts for all to authenticated using (false) with check (false);
