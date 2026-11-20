-- Access is scoped to the bot, not to a reusable display name or token.
create table public.bot_control (
 id text primary key check(id='local'), bot_id bigint not null, owner_id bigint not null,
 token_fingerprint text not null,bot_username text not null default '', configured_at timestamptz not null default now()
);
create table public.bot_members (
 bot_id bigint not null,user_id bigint not null check(user_id>0),approved_at timestamptz not null default now(),
 primary key(bot_id,user_id)
);
create table public.access_requests (
 id uuid primary key default gen_random_uuid(),bot_id bigint not null,user_id bigint not null check(user_id>0),
 first_name text not null check(char_length(first_name)<=100),last_name text not null default '' check(char_length(last_name)<=100),
 username text not null default '' check(char_length(username)<=64),category text not null check(category in ('weather','politics','ai','other')),
 prompt text not null default '' check(char_length(prompt)<=1000),request_id uuid not null,
 channel text not null check(channel in ('chat','miniapp')),status text not null default 'pending' check(status in ('pending','approved','denied','expired')),
 notice_until timestamptz,owner_message_id bigint,job_id uuid references public.jobs(id),error_message text check(char_length(error_message)<=500),
 created_at timestamptz not null default now(),decided_at timestamptz,
 unique(bot_id,user_id,request_id)
);
create unique index access_one_pending on public.access_requests(bot_id,user_id) where status='pending';
create index access_user_created on public.access_requests(bot_id,user_id,created_at desc);
create table public.chat_deliveries (
 job_id uuid primary key references public.jobs(id),chat_id bigint not null,parts_sent integer not null default 0,
 lease_until timestamptz,done boolean not null default false,created_at timestamptz not null default now()
);
alter table public.jobs add column bot_id bigint;
create index jobs_bot_queue on public.jobs(bot_id,status,created_at) where status in ('queued','processing');
alter table public.bot_control enable row level security;
alter table public.bot_members enable row level security;
alter table public.access_requests enable row level security;
alter table public.chat_deliveries enable row level security;
revoke all on public.bot_control,public.bot_members,public.access_requests,public.chat_deliveries from public,anon,authenticated;
grant select,insert,update,delete on public.bot_control,public.bot_members,public.access_requests,public.chat_deliveries to service_role;

create function public.request_access(p_bot bigint,p_user bigint,p_first text,p_last text,p_username text,p_category text,p_prompt text,p_request uuid,p_channel text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare r public.access_requests;
begin
 perform pg_advisory_xact_lock(p_user);
 if not exists(select 1 from public.bot_control where id='local' and bot_id=p_bot) then raise exception 'wrong bot'; end if;
 update public.access_requests set status='expired',decided_at=now() where bot_id=p_bot and user_id=p_user and status='pending' and created_at<now()-interval '24 hours';
 select * into r from public.access_requests where bot_id=p_bot and user_id=p_user and (request_id=p_request or status='pending') order by created_at desc limit 1;
 if found then return to_jsonb(r); end if;
 if exists(select 1 from public.access_requests where bot_id=p_bot and user_id=p_user and status='denied' and decided_at>now()-interval '10 minutes') then return jsonb_build_object('status','denied'); end if;
 if (select count(*) from public.access_requests where bot_id=p_bot and status='pending')>=100 then return jsonb_build_object('status','full'); end if;
 insert into public.access_requests(bot_id,user_id,first_name,last_name,username,category,prompt,request_id,channel)
 values(p_bot,p_user,p_first,p_last,p_username,p_category,p_prompt,p_request,p_channel) returning * into r;
 return to_jsonb(r);
end; $$;

create function public.decide_access(p_id uuid,p_admin bigint,p_message bigint,p_allow boolean) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare r public.access_requests;
begin
 select * into r from public.access_requests where id=p_id for update;
 if not found or not exists(select 1 from public.bot_control where id='local' and owner_id=p_admin and bot_id=r.bot_id) or r.owner_message_id is distinct from p_message then return null; end if;
 if r.status<>'pending' then return null; end if;
 if r.created_at<now()-interval '24 hours' then update public.access_requests set status='expired',decided_at=now() where id=r.id;return null;end if;
 update public.access_requests set status=case when p_allow then 'approved' else 'denied' end,decided_at=now() where id=r.id returning * into r;
 if p_allow then insert into public.bot_members(bot_id,user_id) values(r.bot_id,r.user_id) on conflict do nothing; end if;
 return to_jsonb(r);
end; $$;

-- One local worker handles the owner's and explicitly approved guests' jobs.
create or replace function public.worker_ping(p_owner bigint,p_ready boolean,p_model text,p_job uuid default null,p_lease uuid default null) returns void
language plpgsql security invoker set search_path='' as $$
begin
 update public.worker_state set last_seen=now(),ready=p_ready,model=left(p_model,100) where id='local';
 if p_job is not null then update public.jobs j set lease_until=now()+interval '60 seconds' where id=p_job and lease_token=p_lease and status='processing'
 and (owner_telegram_id=p_owner or exists(select 1 from public.bot_control c join public.bot_members m on m.bot_id=c.bot_id where c.owner_id=p_owner and m.user_id=j.owner_telegram_id and j.bot_id=c.bot_id));end if;
end; $$;
create or replace function public.worker_claim(p_owner bigint) returns jsonb language plpgsql security invoker set search_path='' as $$
declare j public.jobs;u bigint;
begin
 perform pg_advisory_xact_lock(p_owner);
 for u in select distinct owner_telegram_id from public.jobs where status in ('queued','processing') loop perform public.expire_jobs(u);end loop;
 if not public.worker_online() then return null;end if;
 if exists(select 1 from public.jobs where status='processing' and lease_until>now()) then return null;end if;
 select * into j from public.jobs j where status='queued' and category<>'weather' and
 (owner_telegram_id=p_owner or exists(select 1 from public.bot_control c join public.bot_members m on m.bot_id=c.bot_id where c.owner_id=p_owner and m.user_id=j.owner_telegram_id and j.bot_id=c.bot_id))
 order by created_at for update skip locked limit 1;
 if not found then return null;end if;
 update public.jobs set status='processing',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '60 seconds' where id=j.id returning * into j;
 return jsonb_build_object('id',j.id,'category',j.category,'prompt',j.prompt,'lease',j.lease_token);
end; $$;
create or replace function public.worker_finish(p_owner bigint,p_job uuid,p_lease uuid,p_response jsonb,p_error text) returns boolean
language plpgsql security invoker set search_path='' as $$
declare j public.jobs;
begin
 select * into j from public.jobs where id=p_job and (owner_telegram_id=p_owner or exists(select 1 from public.bot_control c join public.bot_members m on m.bot_id=c.bot_id where c.owner_id=p_owner and m.user_id=owner_telegram_id and jobs.bot_id=c.bot_id)) for update;
 if not found or j.lease_token is distinct from p_lease then return false;end if;
 if j.status in ('completed','failed') then return true;end if;
 if j.status<>'processing' or j.lease_until<now() then return false;end if;
 perform public.finish_job(j.owner_telegram_id,p_job,p_response,p_error);return true;
end; $$;
create function public.claim_chat_delivery(p_job uuid) returns jsonb language plpgsql security invoker set search_path='' as $$
declare d public.chat_deliveries;
begin
 update public.chat_deliveries set lease_until=now()+interval '45 seconds' where job_id=p_job and not done and (lease_until is null or lease_until<now()) returning * into d;
 if not found then return null;end if;return to_jsonb(d);
end; $$;
revoke execute on function public.request_access(bigint,bigint,text,text,text,text,text,uuid,text),public.decide_access(uuid,bigint,bigint,boolean),public.claim_chat_delivery(uuid) from public,anon,authenticated;
grant execute on function public.request_access(bigint,bigint,text,text,text,text,text,uuid,text),public.decide_access(uuid,bigint,bigint,boolean),public.claim_chat_delivery(uuid) to service_role;

create function public.claim_access_notice(p_id uuid) returns boolean language plpgsql security invoker set search_path='' as $$
begin
 update public.access_requests set notice_until=now()+interval '30 seconds' where id=p_id and status='pending' and owner_message_id is null and (notice_until is null or notice_until<now());return found;
end; $$;
revoke execute on function public.claim_access_notice(uuid) from public,anon,authenticated;
grant execute on function public.claim_access_notice(uuid) to service_role;

create or replace function public.begin_news_job(p_owner bigint,p_category text,p_prompt text,p_request_id uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare j public.jobs; r jsonb;
begin
 if p_category not in ('politics','ai','other') then raise exception 'invalid news category'; end if;
 perform pg_advisory_xact_lock(-987654321);
 perform pg_advisory_xact_lock(p_owner);
 select * into j from public.jobs where owner_telegram_id=p_owner and request_id=p_request_id;
 if found then
  if j.category<>p_category or j.prompt<>p_prompt then return jsonb_build_object('error','conflict'); end if;
  return jsonb_build_object('job',to_jsonb(j),'created',false);
 end if;
 if not public.worker_online() then return jsonb_build_object('error','worker_offline'); end if;
 perform public.expire_jobs(p_owner);
 if (select count(*) from public.jobs where status in ('queued','processing') and category<>'weather')>=3 then return jsonb_build_object('error','queue_full'); end if;
 r:=public.begin_job(p_owner,p_category,p_prompt,p_request_id);
 if r ? 'error' then return r; end if;
 update public.jobs set status='queued' where id=(r->'job'->>'id')::uuid returning * into j;
 return jsonb_build_object('job',to_jsonb(j),'created',true);
end; $$;

