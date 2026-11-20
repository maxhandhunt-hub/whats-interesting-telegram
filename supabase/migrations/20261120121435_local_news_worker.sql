alter table public.jobs add column lease_token uuid;
alter table public.jobs add column lease_until timestamptz;
alter table public.jobs add column attempts integer not null default 0 check (attempts between 0 and 2);
create table public.worker_state (
 id text primary key check(id='local'),
 token_hash text not null check(token_hash ~ '^[0-9a-f]{64}$'),
 last_seen timestamptz,
 ready boolean not null default false,
 model text not null default '' check(char_length(model)<=100)
);
alter table public.worker_state enable row level security;
revoke all on public.worker_state from public,anon,authenticated;
grant select,insert,update,delete on public.worker_state to service_role;

create function public.worker_online() returns boolean language sql security invoker set search_path='' as $$
 select coalesce((select ready and last_seen > now()-interval '45 seconds' from public.worker_state where id='local'),false);
$$;

create or replace function public.expire_jobs(p_owner bigint) returns void language plpgsql security invoker set search_path='' as $$
begin
 update public.jobs set status='failed',completed_at=now(),error_message='Время ожидания локального обработчика истекло. Повторите запрос.'
 where owner_telegram_id=p_owner and ((status='queued' and created_at<now()-interval '15 minutes')
 or (status='processing' and lease_until<now() and attempts>=2)
 or (status='processing' and lease_token is null and created_at<now()-interval '5 minutes'));
 update public.jobs set status='queued',lease_token=null,lease_until=null
 where owner_telegram_id=p_owner and status='processing' and lease_until<now() and attempts<2;
end; $$;

create function public.begin_news_job(p_owner bigint,p_category text,p_prompt text,p_request_id uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare j public.jobs; r jsonb;
begin
 if p_category not in ('politics','ai','other') then raise exception 'invalid news category'; end if;
 perform pg_advisory_xact_lock(p_owner);
 select * into j from public.jobs where owner_telegram_id=p_owner and request_id=p_request_id;
 if found then
  if j.category<>p_category or j.prompt<>p_prompt then return jsonb_build_object('error','conflict'); end if;
  return jsonb_build_object('job',to_jsonb(j),'created',false);
 end if;
 if not public.worker_online() then return jsonb_build_object('error','worker_offline'); end if;
 perform public.expire_jobs(p_owner);
 if (select count(*) from public.jobs where owner_telegram_id=p_owner and status in ('queued','processing') and category<>'weather')>=3 then return jsonb_build_object('error','queue_full'); end if;
 r:=public.begin_job(p_owner,p_category,p_prompt,p_request_id);
 if r ? 'error' then return r; end if;
 update public.jobs set status='queued' where id=(r->'job'->>'id')::uuid returning * into j;
 return jsonb_build_object('job',to_jsonb(j),'created',true);
end; $$;

create function public.worker_ping(p_owner bigint,p_ready boolean,p_model text,p_job uuid default null,p_lease uuid default null) returns void
language plpgsql security invoker set search_path='' as $$
begin
 update public.worker_state set last_seen=now(),ready=p_ready,model=left(p_model,100) where id='local';
 if p_job is not null then update public.jobs set lease_until=now()+interval '60 seconds' where id=p_job and owner_telegram_id=p_owner and lease_token=p_lease and status='processing'; end if;
end; $$;

create function public.worker_claim(p_owner bigint) returns jsonb language plpgsql security invoker set search_path='' as $$
declare j public.jobs;
begin
 perform pg_advisory_xact_lock(p_owner);
 perform public.expire_jobs(p_owner);
 if not public.worker_online() then return null; end if;
 if exists(select 1 from public.jobs where owner_telegram_id=p_owner and status='processing' and lease_until>now()) then return null; end if;
 select * into j from public.jobs where owner_telegram_id=p_owner and status='queued' and category<>'weather' order by created_at for update skip locked limit 1;
 if not found then return null; end if;
 update public.jobs set status='processing',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '60 seconds' where id=j.id returning * into j;
 return jsonb_build_object('id',j.id,'category',j.category,'prompt',j.prompt,'lease',j.lease_token);
end; $$;

create function public.worker_finish(p_owner bigint,p_job uuid,p_lease uuid,p_response jsonb,p_error text) returns boolean
language plpgsql security invoker set search_path='' as $$
declare j public.jobs;
begin
 select * into j from public.jobs where id=p_job and owner_telegram_id=p_owner for update;
 if not found or j.lease_token is distinct from p_lease then return false; end if;
 if j.status in ('completed','failed') then return true; end if;
 if j.status<>'processing' or j.lease_until<now() then return false; end if;
 perform public.finish_job(p_owner,p_job,p_response,p_error);
 return true;
end; $$;

revoke execute on function public.worker_online(),public.begin_news_job(bigint,text,text,uuid),public.worker_ping(bigint,boolean,text,uuid,uuid),public.worker_claim(bigint),public.worker_finish(bigint,uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.worker_online(),public.begin_news_job(bigint,text,text,uuid),public.worker_ping(bigint,boolean,text,uuid,uuid),public.worker_claim(bigint),public.worker_finish(bigint,uuid,uuid,jsonb,text) to service_role;
