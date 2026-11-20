import {Access} from './access.ts';
import {AppError,isUuid,parseCreate,type Job,type Answer} from '../../../shared/contracts.ts';
import {verifyTelegramUser} from '../../../shared/auth.ts';
import {fetchWeather} from '../../../shared/answers.ts';
import {normalizeJob} from '../../../shared/jobs.ts';

declare const Deno:{env:{get(name:string):string|undefined};serve(handler:(req:Request)=>Promise<Response>):void};
const originAllowed='https://maxhandhunt-hub.github.io';
function env(name:string){return Deno.env.get(name)||'';}
function serverKey(){
 try{const keys=JSON.parse(env('SUPABASE_SECRET_KEYS')||'{}');if(keys.default)return keys.default as string;}catch{/* Legacy key below. */}
 return env('SUPABASE_SERVICE_ROLE_KEY');
}
async function db(path:string,method='GET',body?:unknown){
 const url=env('SUPABASE_URL'),key=serverKey();
 if(!url||!key)throw new AppError('CONFIG','Подключение базы данных не настроено.',503);
 const r=await fetch(`${url}/rest/v1/${path}`,{method,headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json',Prefer:'return=representation'+(path.includes('on_conflict=')?',resolution=merge-duplicates':'')},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(12000)});
 if(!r.ok)throw new AppError('DATABASE','База данных временно недоступна. Повторите запрос.',503);
 return r.status===204?null:await r.json();
}
async function getJob(owner:string,id:string){
 if(!isUuid(id))throw new AppError('JOB_ID','Некорректный номер задания.');
 await db('rpc/expire_jobs','POST',{p_owner:owner});
 const rows=await db(`jobs?owner_telegram_id=eq.${owner}&id=eq.${id}&select=id,category,prompt,status,created_at,updated_at,completed_at,error_message,results(response_json)&limit=1`);
 if(!rows[0])throw new AppError('NOT_FOUND','Задание не найдено.',404);
 const job=normalizeJob(rows[0]);
 return {...job,worker_online:job.category==='weather'?true:await db('rpc/worker_online','POST',{})};
}
async function readBody(req:Request){
 if(!req.headers.get('content-type')?.toLowerCase().startsWith('application/json'))throw new AppError('CONTENT_TYPE','Ожидается JSON.',415);
 const reader=req.body?.getReader();if(!reader)throw new AppError('BODY','Пустой запрос.');
 const chunks:Uint8Array[]=[];let length=0;
 for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>65536){await reader.cancel();throw new AppError('BODY_SIZE','Слишком большой запрос.',413);}chunks.push(value);}
 const bytes=new Uint8Array(length);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
 let body;try{body=JSON.parse(new TextDecoder().decode(bytes));if(!body||typeof body!=='object'||Array.isArray(body))throw Error();}catch{throw new AppError('JSON','Некорректный JSON.');}
 if(!String(body.action).startsWith('worker_')&&length>16384)throw new AppError('BODY_SIZE','Слишком большой запрос.',413);
 return body as Record<string,unknown>;
}
async function handleWorker(req:Request,body:Record<string,unknown>){
 if(req.headers.get('origin'))throw new AppError('WORKER_AUTH','Этот метод доступен только локальному обработчику.',403);
 const token=(req.headers.get('authorization')||'').replace(/^Bearer /,'');
 if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw new AppError('WORKER_AUTH','Ключ обработчика не принят.',401);
 const rows=await db('worker_state?id=eq.local&select=token_hash&limit=1');
 const expected=rows[0]?.token_hash||'';
 const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)));
 const actual=[...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');
 let diff=actual.length^expected.length;for(let i=0;i<actual.length;i++)diff|=actual.charCodeAt(i)^(expected.charCodeAt(i)||0);
 if(diff)throw new AppError('WORKER_AUTH','Ключ обработчика не принят.',401);
 const owner=env('ALLOWED_TELEGRAM_USER_ID');
 if(!/^\d+$/.test(owner))throw new AppError('CONFIG','Владелец очереди не настроен.',503);
 if(!await db('rpc/consume_request','POST',{p_owner:owner}))throw new AppError('RATE_LIMIT','Слишком много обращений к очереди. Подождите минуту.',429);
 if(body.action==='worker_ping'){
  const job=body.jobId?String(body.jobId):null,lease=body.lease?String(body.lease):null;
  if((job&&!isUuid(job))||(lease&&!isUuid(lease)))throw new AppError('WORKER_INPUT','Некорректная аренда задания.');
  await db('rpc/worker_ping','POST',{p_owner:owner,p_ready:body.ready===true,p_model:String(body.model||'').slice(0,100),p_job:job,p_lease:lease});
  await access().configure();await access().flush();
  return {ok:true};
 }
 if(body.action==='worker_claim')return {job:await db('rpc/worker_claim','POST',{p_owner:owner})};
 if(body.action==='worker_complete'){
  if(!isUuid(String(body.jobId))||!isUuid(String(body.lease)))throw new AppError('WORKER_INPUT','Некорректный номер задания.');
  const answer=body.answer as Answer|null,error=body.error===null?null:String(body.error||'').slice(0,500);
  if(!error){
   if(!answer||answer.mode!=='news'||!Array.isArray(answer.items)||!answer.items.length||answer.items.length>15||typeof answer.title!=='string'||typeof answer.body!=='string'||!Array.isArray(answer.sources)||JSON.stringify(answer).length>48000)throw new AppError('WORKER_RESULT','Некорректный результат обработчика.');
   if(answer.sources.some(s=>!s.url?.startsWith('https://')))throw new AppError('WORKER_RESULT','Некорректные ссылки результата.');
  }
  const accepted=await db('rpc/worker_finish','POST',{p_owner:owner,p_job:body.jobId,p_lease:body.lease,p_response:error?null:answer,p_error:error});
  if(!accepted)throw new AppError('LEASE','Аренда задания истекла или сменилась.',409);
  try{await access().deliver(String(body.jobId));}catch{/* delivery resumes on heartbeat without another GPT call */}
  return {ok:true};
 }
 throw new AppError('ACTION','Неизвестное действие обработчика.');
}
function access(){return new Access(db,env('TELEGRAM_BOT_TOKEN'),env('ALLOWED_TELEGRAM_USER_ID'),env('SUPABASE_URL'),executeJob);}
async function executeJob(owner:string,input:ReturnType<typeof parseCreate>,chat:boolean):Promise<Job>{
 const reserved=await db('rpc/'+(input.category==='weather'?'begin_job':'begin_news_job'),'POST',{p_owner:owner,p_category:input.category,p_prompt:input.prompt,p_request_id:input.requestId});
 if(reserved.error==='worker_offline')throw new AppError('WORKER_OFFLINE','Локальный обработчик недоступен. Владелец должен включить ноутбук и приложение.',503);
 if(reserved.error==='queue_full')throw new AppError('QUEUE_FULL','Очередь занята. Дождитесь завершения предыдущих запросов.',429);
 if(reserved.error==='rate_limit')throw new AppError('RATE_LIMIT','Достигнут лимит: 6 новых запросов в минуту или 100 за сутки.',429);
 if(reserved.error==='conflict')throw new AppError('CONFLICT','Этот номер запроса уже использован с другим содержимым.',409);
 const job=reserved.job as Job;
 await db(`jobs?id=eq.${job.id}&owner_telegram_id=eq.${owner}`,'PATCH',{bot_id:await access().botId()});
 if(chat)await db('chat_deliveries?on_conflict=job_id','POST',{job_id:job.id,chat_id:owner});
 if(reserved.created&&input.category==='weather'){
  try{const answer=await fetchWeather();await db('rpc/finish_job','POST',{p_owner:owner,p_job:job.id,p_response:answer,p_error:null});}
  catch(error){await db('rpc/finish_job','POST',{p_owner:owner,p_job:job.id,p_response:null,p_error:error instanceof AppError?error.message:'Обработка запроса прервалась. Попробуйте ещё раз.'});}
 }
 if(chat){try{await access().deliver(job.id);}catch{/* retried by heartbeat */}}
 return await getJob(owner,job.id);
}
export async function handler(req:Request):Promise<Response>{
 const origin=req.headers.get('origin');
 const headers:Record<string,string>={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',Vary:'Origin'};
 if(origin===originAllowed){headers['Access-Control-Allow-Origin']=origin;headers['Access-Control-Allow-Methods']='POST, OPTIONS';headers['Access-Control-Allow-Headers']='content-type';headers['Access-Control-Max-Age']='600';}
 const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers});
 if(origin&&origin!==originAllowed)return reply({error:{code:'ORIGIN',message:'Этот сайт не имеет доступа к приложению.'}},403);
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
 if(req.method!=='POST')return reply({error:{code:'METHOD',message:'Используйте POST.'}},405);
 try{
  const body=await readBody(req);
  if(String(body.action).startsWith('worker_'))return reply(await handleWorker(req,body));
  if(new URL(req.url).searchParams.get('telegram')==='1'){await access().checkWebhook(req);await access().update(body);return reply({ok:true});}
  const user=await verifyTelegramUser(body.initData,env('TELEGRAM_BOT_TOKEN'),env('ALLOWED_TELEGRAM_USER_ID')),owner=user.id;
  if(!['auth','create','status','history','access_status'].includes(String(body.action)))throw new AppError('ACTION','Неизвестное действие.');
  const rate=await db('rpc/consume_request','POST',{p_owner:owner});
  if(!rate)throw new AppError('RATE_LIMIT','Слишком много обращений. Подождите минуту.',429);
  if(body.action==='access_status')return reply({access:await access().status(owner,String(body.accessId||''))});
  const granted=await access().allowed(owner);
  if(body.action==='auth'){if(owner===env('ALLOWED_TELEGRAM_USER_ID'))await access().configure();return reply({authorized:granted});}
  if(body.action==='create'){
   const input=parseCreate(body);
   if(!granted)return reply({access:await access().request(user,input,'miniapp')});
   return reply({job:await executeJob(owner,input,false)});
  }
  if(!granted)throw new AppError('FORBIDDEN','Сначала выберите раздел и дождитесь разрешения владельца.',403);
  if(body.action==='history'){
   await db('rpc/expire_jobs','POST',{p_owner:owner});
   const rows=await db(`jobs?owner_telegram_id=eq.${owner}&select=id,category,prompt,status,created_at,updated_at,completed_at,error_message,results(response_json)&order=created_at.desc&limit=50`);
   return reply({jobs:rows.map(normalizeJob).filter((job:Job)=>job.answer?.mode!=='demo')});
  }
  if(body.action==='status')return reply({job:await getJob(owner,String(body.jobId||''))});
  throw new AppError('ACTION','Неизвестное действие.');
 }catch(error){
  const safe=error instanceof AppError?error:new AppError('UNAVAILABLE','Сервис временно недоступен. Попробуйте ещё раз.',503);
  // No request bodies, Telegram initData, credentials or raw exceptions in logs.
  return reply({error:{code:safe.code,message:safe.message}},safe.status);
 }
}
Deno.serve(handler);
