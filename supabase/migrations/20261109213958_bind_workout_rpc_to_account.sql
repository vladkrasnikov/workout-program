drop function public.workout_get_changes(jsonb,text[]);
drop function public.workout_apply_change(uuid,text,text,bigint,integer,jsonb,boolean);
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
