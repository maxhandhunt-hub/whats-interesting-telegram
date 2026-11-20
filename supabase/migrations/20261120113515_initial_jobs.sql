create table public.jobs (
 id uuid primary key default gen_random_uuid(),
 owner_telegram_id bigint not null check (owner_telegram_id > 0),
 category text not null check (category in ('weather','politics','ai','other')),
 prompt text not null default '' check (char_length(prompt) <= 1000),
 status text not null default 'queued' check (status in ('queued','processing','completed','failed')),
 request_id uuid not null,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 completed_at timestamptz,
 error_message text check (char_length(error_message) <= 500),
 unique(owner_telegram_id,request_id),
 check ((status in ('completed','failed')) = (completed_at is not null)),
 check ((status = 'failed') = (error_message is not null))
);
create index jobs_owner_created_idx on public.jobs(owner_telegram_id,created_at desc);
create index jobs_active_idx on public.jobs(status,created_at) where status in ('queued','processing');
create table public.results (
 id uuid primary key default gen_random_uuid(),
 job_id uuid not null unique references public.jobs(id) on delete cascade,
 response_json jsonb not null check (jsonb_typeof(response_json) = 'object' and octet_length(response_json::text) <= 50000),
 created_at timestamptz not null default now()
);
create table public.request_limits (
 owner_telegram_id bigint primary key check (owner_telegram_id > 0),
 minute_start timestamptz not null,
 calls integer not null check (calls > 0)
);
alter table public.jobs enable row level security;
alter table public.results enable row level security;
alter table public.request_limits enable row level security;
revoke all on public.jobs, public.results, public.request_limits from public,anon,authenticated;
grant select,insert,update,delete on public.jobs, public.results, public.request_limits to service_role;
comment on table public.jobs is 'Telegram jobs. Access only through signature-verifying Edge Function; no public RLS policies.';

create function public.touch_job() returns trigger language plpgsql security invoker set search_path = '' as $$
begin new.updated_at=now(); return new; end; $$;
create trigger touch_job before update on public.jobs for each row execute function public.touch_job();

create function public.consume_request(p_owner bigint) returns boolean language plpgsql security invoker set search_path = '' as $$
declare n integer;
begin
 insert into public.request_limits as limits(owner_telegram_id,minute_start,calls)
 values(p_owner,date_trunc('minute',now()),1)
 on conflict(owner_telegram_id) do update set
 calls=case when limits.minute_start=excluded.minute_start then limits.calls+1 else 1 end,
 minute_start=excluded.minute_start returning calls into n;
 return n <= 120;
end; $$;

create function public.expire_jobs(p_owner bigint) returns void language sql security invoker set search_path = '' as $$
 update public.jobs set status='failed',completed_at=now(),error_message='Время обработки истекло. Создайте новый запрос.'
 where owner_telegram_id=p_owner and status in ('queued','processing') and created_at < now()-interval '5 minutes';
$$;

create function public.begin_job(p_owner bigint,p_category text,p_prompt text,p_request_id uuid) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare j public.jobs; n_min integer; n_day integer;
begin
 perform pg_advisory_xact_lock(p_owner);
 select * into j from public.jobs where owner_telegram_id=p_owner and request_id=p_request_id;
 if found then
  if j.category<>p_category or j.prompt<>p_prompt then return jsonb_build_object('error','conflict'); end if;
  return jsonb_build_object('job',to_jsonb(j),'created',false);
 end if;
 select count(*) filter(where created_at >= now()-interval '1 minute'),count(*)
 into n_min,n_day from public.jobs where owner_telegram_id=p_owner and created_at>=now()-interval '24 hours';
 if n_min>=6 or n_day>=100 then return jsonb_build_object('error','rate_limit'); end if;
 perform public.expire_jobs(p_owner);
 insert into public.jobs(owner_telegram_id,category,prompt,request_id,status)
 values(p_owner,p_category,p_prompt,p_request_id,'processing') returning * into j;
 return jsonb_build_object('job',to_jsonb(j),'created',true);
end; $$;

create function public.finish_job(p_owner bigint,p_job uuid,p_response jsonb,p_error text) returns void
language plpgsql security invoker set search_path = '' as $$
declare j public.jobs;
begin
 select * into j from public.jobs where id=p_job and owner_telegram_id=p_owner for update;
 if not found or j.status not in ('processing','queued') then return; end if;
 if p_error is null then
  if p_response is null then raise exception 'response required'; end if;
  insert into public.results(job_id,response_json) values(p_job,p_response);
  update public.jobs set status='completed',completed_at=now(),error_message=null where id=p_job;
 else
  update public.jobs set status='failed',completed_at=now(),error_message=left(p_error,500) where id=p_job;
 end if;
end; $$;

revoke execute on function public.touch_job(),public.consume_request(bigint),public.expire_jobs(bigint),public.begin_job(bigint,text,text,uuid),public.finish_job(bigint,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.consume_request(bigint),public.expire_jobs(bigint),public.begin_job(bigint,text,text,uuid),public.finish_job(bigint,uuid,jsonb,text) to service_role;
