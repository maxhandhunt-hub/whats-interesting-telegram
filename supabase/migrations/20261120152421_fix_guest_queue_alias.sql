create or replace function public.worker_claim(p_owner bigint) returns jsonb language plpgsql security invoker set search_path='' as $$
declare j public.jobs;u bigint;
begin
 perform pg_advisory_xact_lock(p_owner);
 for u in select distinct owner_telegram_id from public.jobs where status in ('queued','processing') loop perform public.expire_jobs(u);end loop;
 if not public.worker_online() then return null;end if;
 if exists(select 1 from public.jobs where status='processing' and lease_until>now()) then return null;end if;
 select q.* into j from public.jobs q where status='queued' and category<>'weather' and
 (owner_telegram_id=p_owner or exists(select 1 from public.bot_control c join public.bot_members m on m.bot_id=c.bot_id where c.owner_id=p_owner and m.user_id=q.owner_telegram_id and q.bot_id=c.bot_id))
 order by created_at for update skip locked limit 1;
 if not found then return null;end if;
 update public.jobs set status='processing',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '60 seconds' where id=j.id returning * into j;
 return jsonb_build_object('id',j.id,'category',j.category,'prompt',j.prompt,'lease',j.lease_token);
end; $$;
