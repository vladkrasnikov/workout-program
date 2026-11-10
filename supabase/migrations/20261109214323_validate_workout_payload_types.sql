create or replace function workout_private.valid_session(p_id text, p_payload jsonb)
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
