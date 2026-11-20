import {AppError,isUuid,parseCreate,type Job,type Answer} from '../../../shared/contracts.ts';
import {verifyTelegram} from '../../../shared/auth.ts';
import {demoAnswer,fetchWeather} from '../../../shared/answers.ts';
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
 const r=await fetch(`${url}/rest/v1/${path}`,{method,headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(12000)});
 if(!r.ok)throw new AppError('DATABASE','База данных временно недоступна. Повторите запрос.',503);
 return r.status===204?null:await r.json();
}
async function getJob(owner:string,id:string){
 if(!isUuid(id))throw new AppError('JOB_ID','Некорректный номер задания.');
 await db('rpc/expire_jobs','POST',{p_owner:owner});
 const rows=await db(`jobs?owner_telegram_id=eq.${owner}&id=eq.${id}&select=id,category,prompt,status,created_at,updated_at,completed_at,error_message,results(response_json)&limit=1`);
 if(!rows[0])throw new AppError('NOT_FOUND','Задание не найдено.',404);
 return normalizeJob(rows[0]);
}
async function readBody(req:Request){
 if(!req.headers.get('content-type')?.toLowerCase().startsWith('application/json'))throw new AppError('CONTENT_TYPE','Ожидается JSON.',415);
 const reader=req.body?.getReader();if(!reader)throw new AppError('BODY','Пустой запрос.');
 const chunks:Uint8Array[]=[];let length=0;
 for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>16384){await reader.cancel();throw new AppError('BODY_SIZE','Слишком большой запрос.',413);}chunks.push(value);}
 const bytes=new Uint8Array(length);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
 try{const body=JSON.parse(new TextDecoder().decode(bytes));if(!body||typeof body!=='object'||Array.isArray(body))throw Error();return body as Record<string,unknown>;}catch{throw new AppError('JSON','Некорректный JSON.');}
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
  const owner=await verifyTelegram(body.initData,env('TELEGRAM_BOT_TOKEN'),env('ALLOWED_TELEGRAM_USER_ID'));
  if(!['auth','create','status','history'].includes(String(body.action)))throw new AppError('ACTION','Неизвестное действие.');
  const rate=await db('rpc/consume_request','POST',{p_owner:owner});
  if(!rate)throw new AppError('RATE_LIMIT','Слишком много обращений. Подождите минуту.',429);
  if(body.action==='auth')return reply({authorized:true});
  if(body.action==='history'){
   await db('rpc/expire_jobs','POST',{p_owner:owner});
   const rows=await db(`jobs?owner_telegram_id=eq.${owner}&select=id,category,prompt,status,created_at,updated_at,completed_at,error_message,results(response_json)&order=created_at.desc&limit=50`);
   return reply({jobs:rows.map(normalizeJob)});
  }
  if(body.action==='status')return reply({job:await getJob(owner,String(body.jobId||''))});
  const input=parseCreate(body);
  const reserved=await db('rpc/begin_job','POST',{p_owner:owner,p_category:input.category,p_prompt:input.prompt,p_request_id:input.requestId});
  if(reserved.error==='rate_limit')throw new AppError('RATE_LIMIT','Достигнут лимит: 6 новых запросов в минуту или 100 за сутки.',429);
  if(reserved.error==='conflict')throw new AppError('CONFLICT','Этот номер запроса уже использован с другим содержимым.',409);
  const job=reserved.job as Job;
  if(!reserved.created)return reply({job:await getJob(owner,job.id)});
  try{
   const answer=input.category==='weather'?await fetchWeather():demoAnswer(input.category,input.prompt);
   await db('rpc/finish_job','POST',{p_owner:owner,p_job:job.id,p_response:answer,p_error:null});
  }catch(error){
   const message=error instanceof AppError?error.message:'Обработка запроса прервалась. Попробуйте ещё раз.';
   await db('rpc/finish_job','POST',{p_owner:owner,p_job:job.id,p_response:null,p_error:message});
  }
  return reply({job:await getJob(owner,job.id)});
 }catch(error){
  const safe=error instanceof AppError?error:new AppError('UNAVAILABLE','Сервис временно недоступен. Попробуйте ещё раз.',503);
  // No request bodies, Telegram initData, credentials or raw exceptions in logs.
  return reply({error:{code:safe.code,message:safe.message}},safe.status);
 }
}
Deno.serve(handler);
