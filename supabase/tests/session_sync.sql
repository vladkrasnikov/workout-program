-- Run as the SQL-editor/database owner after applying migrations. No email is sent.
-- Assertions use authenticated roles; every fixture and protocol switch rolls back.
begin;
select set_config('workout.test_a',gen_random_uuid()::text,true),set_config('workout.test_b',gen_random_uuid()::text,true);
insert into auth.users(id) values (current_setting('workout.test_a')::uuid),(current_setting('workout.test_b')::uuid);
insert into public.workout_snapshots(user_id,snapshot,revision) values (current_setting('workout.test_a')::uuid,'{"sessions":[{"id":"session-test-aggregate","programId":"spine-safe","dayId":"a","workoutDate":"2026-11-09","performedAt":"2026-11-09T12:00:00Z","status":"draft"}],"entries":[{"id":"entry-test","sessionId":"session-test-aggregate","slotId":"spine-safe:a:a1","metric":"load-reps","sets":[{"id":"set-test","order":1,"kind":"working","side":"both","metric":"load-reps","confirmed":false,"loadKg":null,"reps":null,"durationSeconds":null}]}],"settings":[{"key":"activeSessionId","value":"session-test-aggregate"},{"key":"examplePreference","value":true}]}'::jsonb,7);
select set_config('workout.test_bundle','{"session":{"id":"session-test-aggregate","programId":"spine-safe","dayId":"a","workoutDate":"2026-11-09","performedAt":"2026-11-09T12:00:00Z","status":"draft"},"entries":[{"id":"entry-test","sessionId":"session-test-aggregate","slotId":"spine-safe:a:a1","metric":"load-reps","sets":[{"id":"set-test","order":1,"kind":"working","side":"both","metric":"load-reps","confirmed":false,"loadKg":null,"reps":null,"durationSeconds":null}]}]}',true);
select set_config('workout.test_id','session-test-aggregate',true);
select set_config('workout.test_op',gen_random_uuid()::text,true);
set local role authenticated;
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('workout.test_a'),'role','authenticated')::text,true);
do $$ declare changes jsonb; r jsonb; v jsonb:=current_setting('workout.test_bundle')::jsonb; id text:=current_setting('workout.test_id'); op uuid:=current_setting('workout.test_op')::uuid;
begin
changes:=public.workout_get_changes(auth.uid());
if jsonb_array_length(changes)<>2 then raise exception 'Legacy migration lost records or synchronized device pointers'; end if;
if not exists(select 1 from jsonb_array_elements(changes) x where x->>'kind'='session' and x->>'revision'='7' and x->'payload'=v) then raise exception 'Legacy workout content changed'; end if;
r:=public.workout_apply_change(auth.uid(),op,'session',id,7,1,v,false);
if r->>'revision'<>'8' then raise exception 'CAS write failed: %',r; end if;
r:=public.workout_apply_change(auth.uid(),op,'session',id,7,1,v,false);
if r->>'revision'<>'8' then raise exception 'Idempotent retry incremented revision'; end if;
r:=public.workout_apply_change(auth.uid(),gen_random_uuid(),'session',id,8,1,v,false);
if r->>'revision'<>'9' then raise exception 'Second operation failed'; end if;
r:=public.workout_apply_change(auth.uid(),op,'session',id,7,1,v,false);
if r->>'revision'<>'8' then raise exception 'Old receipt must retain accepted revision'; end if;
r:=public.workout_apply_change(auth.uid(),gen_random_uuid(),'session',id,7,1,v,false);
if r->>'status'<>'conflict' or r#>>'{record,revision}'<>'9' then raise exception 'Stale revision not rejected'; end if;
begin perform public.workout_apply_change(auth.uid(),op,'session',id,8,1,v,false); raise exception 'Reused operation accepted different request'; exception when invalid_parameter_value then null; end;
begin perform public.workout_apply_change(auth.uid(),gen_random_uuid(),'session',id,9,2,v,false); raise exception 'Unknown format accepted'; exception when invalid_parameter_value then null; end;
begin perform public.workout_apply_change(auth.uid(),gen_random_uuid(),'session',id,9,1,jsonb_set(v,'{entries,0,sets,0,reps}','-1'),false); raise exception 'Invalid reps accepted'; exception when invalid_parameter_value then null; end;
begin perform public.workout_apply_change(auth.uid(),gen_random_uuid(),'session',id,9,1,jsonb_set(v,'{entries,0,sets,0,order}','"1"'),false); raise exception 'String set order accepted'; exception when invalid_parameter_value then null; end;
begin perform public.workout_apply_change(auth.uid(),gen_random_uuid(),'setting','activeSessionId',0,1,'{"key":"activeSessionId","value":"x"}',false); raise exception 'Device pointer accepted'; exception when invalid_parameter_value then null; end;
begin update public.workout_sessions set revision=900; raise exception 'Direct writes bypass CAS'; exception when insufficient_privilege then null; end;
begin update public.workout_snapshots set revision=99; raise exception 'Old client can still overwrite migrated data'; exception when object_not_in_prerequisite_state then null; end;
r:=public.workout_apply_change(auth.uid(),gen_random_uuid(),'session',id,9,1,null,true);
if r->>'revision'<>'10' then raise exception 'Delete did not increment revision'; end if;
changes:=public.workout_get_changes(auth.uid(),jsonb_build_object('session:'||id,9,'setting:examplePreference',7));
if jsonb_array_length(changes)<>1 or changes#>>'{0,deleted_at}' is null then raise exception 'Deletion not delivered'; end if;
end $$;
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('workout.test_b'),'role','authenticated')::text,true);
do $$ declare changes jsonb; begin
changes:=public.workout_get_changes(auth.uid());
begin perform public.workout_get_changes(current_setting('workout.test_a')::uuid); raise exception 'Old account request accepted under new login'; exception when insufficient_privilege then null; end;
if changes<>'[]'::jsonb then raise exception 'RPC exposed another account'; end if;
if exists(select 1 from public.workout_sessions) or exists(select 1 from public.workout_settings) then raise exception 'RLS exposed another account'; end if;
end $$;
rollback;
select 'PASS: migration preserves app payload; atomic CAS; replay receipts; tombstones; unknown format and malformed payload rejection; old-client guard; cross-account RPC and RLS isolation. All test data rolled back.' as result;
