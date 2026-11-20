import {AppError,type Category,type Job} from '../../../shared/contracts.ts';
import {accessText,parseDecision,telegramChunks,answerText} from '../../../shared/access.ts';
type Db=(path:string,method?:string,body?:unknown)=>Promise<any>;
type User={id:string;first_name:string;last_name:string;username:string};
const appUrl='https://maxhandhunt-hub.github.io/whats-interesting-telegram/';
async function hash(s:string){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))].map(x=>x.toString(16).padStart(2,'0')).join('');}
export class Access {
 constructor(private db:Db,private token:string,private admin:string,private supa:string,private execute:(user:string,input:{category:Category;prompt:string;requestId:string},chat:boolean)=>Promise<Job>){}
 async secret(){const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(this.token),{name:'HMAC',hash:'SHA-256'},false,['sign']);return [...new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode('WhatsInteresting:telegram-webhook:v1')))].map(x=>x.toString(16).padStart(2,'0')).join('');}
 async checkWebhook(req:Request){const expected=await this.secret(),given=req.headers.get('x-telegram-bot-api-secret-token')||'';let n=expected.length^given.length;for(let i=0;i<expected.length;i++)n|=expected.charCodeAt(i)^(given.charCodeAt(i)||0);if(n||req.headers.get('origin'))throw new AppError('WEBHOOK_AUTH','Telegram-подпись запроса не подтверждена.',401);}
 async tg(method:string,body:unknown):Promise<any>{
  let r;try{r=await fetch(`https://api.telegram.org/bot${this.token}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(8000)});}catch{throw new AppError('TELEGRAM','Telegram временно недоступен.',503);}
  const value=await r.json();if(!value.ok)throw new AppError('TELEGRAM','Не удалось отправить сообщение в Telegram. Откройте бота и нажмите /start.',503);return value.result;
 }
 menu(){return {inline_keyboard:[[{text:'Открыть «Что интересного?»',web_app:{url:appUrl}}]]};}
 async send(user:string,text:string,menu=false){return this.tg('sendMessage',{chat_id:user,text,...(menu?{reply_markup:this.menu()}:{})});}
 async configure(){
  const fp=await hash(this.token+':miniapp-only-v2'),old=(await this.db('bot_control?id=eq.local&select=bot_id,token_fingerprint&limit=1'))[0];
  if(old?.token_fingerprint===fp)return;
  const me=await this.tg('getMe',{});
  await this.tg('setWebhook',{url:this.supa+'/functions/v1/telegram-app?telegram=1',secret_token:await this.secret(),allowed_updates:['message','callback_query'],max_connections:4,drop_pending_updates:false});
  await this.tg('setChatMenuButton',{menu_button:{type:'web_app',text:'Что интересного?',web_app:{url:appUrl}}});
  await this.db('bot_control?on_conflict=id','POST',{id:'local',bot_id:me.id,bot_username:String(me.username||''),owner_id:this.admin,token_fingerprint:fp,configured_at:new Date().toISOString()});
  try{await this.send(this.admin,'Меню обновлено. Все разделы теперь только внутри Mini App. При выборе услуги новым пользователем вам придёт заявка на доступ.',true);}catch{/* owner must start the bot to receive notifications */}
 }
 async botId(){const r=await this.db('bot_control?id=eq.local&select=bot_id&limit=1');if(!r[0])throw new AppError('BOT_CONFIG','Обработчик ещё настраивает подключение бота. Повторите через минуту.',503);return String(r[0].bot_id);}
 async allowed(user:string){if(user===this.admin)return true;const bot=await this.botId();return Boolean((await this.db(`bot_members?bot_id=eq.${bot}&user_id=eq.${user}&select=user_id&limit=1`))[0]);}
 async request(user:User,input:{category:Category;prompt:string;requestId:string},channel:'chat'|'miniapp'){
  const r=await this.db('rpc/request_access','POST',{p_bot:await this.botId(),p_user:user.id,p_first:user.first_name,p_last:user.last_name,p_username:user.username,p_category:input.category,p_prompt:input.prompt,p_request:input.requestId,p_channel:channel});
  if(r.status==='full')throw new AppError('ACCESS_FULL','Слишком много заявок. Попробуйте позже.',429);
  if(r.status==='pending'&&!r.owner_message_id){
   // Serialize notification ownership; retries may reclaim after a short crash timeout.
   const claimed=await this.db('rpc/claim_access_notice','POST',{p_id:r.id});
   if(claimed){try{const sent=await this.tg('sendMessage',{chat_id:this.admin,text:accessText({...r,user_id:String(r.user_id)}),reply_markup:{inline_keyboard:[[{text:'Разрешить',callback_data:'access:allow:'+r.id},{text:'Отклонить',callback_data:'access:deny:'+r.id}]]}});await this.db(`access_requests?id=eq.${r.id}`,'PATCH',{owner_message_id:sent.message_id});}catch(e){await this.db(`access_requests?id=eq.${r.id}`,'PATCH',{notice_until:null});throw e;}}
  }
  return {id:r.id,status:r.status};
 }
 async status(user:string,id:string){
  if(!/^[0-9a-f-]{36}$/.test(id))throw new AppError('ACCESS_ID','Некорректный номер заявки.');
  const rows=await this.db(`access_requests?id=eq.${id}&bot_id=eq.${await this.botId()}&user_id=eq.${user}&select=id,status,job_id,error_message&limit=1`);
  if(!rows[0])throw new AppError('NOT_FOUND','Заявка не найдена.',404);return rows[0];
 }
 async removeNotice(message:number){try{await this.tg('deleteMessage',{chat_id:this.admin,message_id:message});}catch{await this.tg('editMessageReplyMarkup',{chat_id:this.admin,message_id:message,reply_markup:{inline_keyboard:[]}});}}
 async decide(id:string,message:number,allow:boolean){
  const r=await this.db('rpc/decide_access','POST',{p_id:id,p_admin:this.admin,p_message:message,p_allow:allow});if(!r)return;
  try{await this.removeNotice(message);}catch{/* decision remains consumed even if Telegram cannot delete it */}
  if(!allow){await this.send(String(r.user_id),'Доступ отклонён владельцем. Повторная заявка возможна через 10 минут.');return;}
  try{await this.send(String(r.user_id),'Доступ разрешён. Выполняю выбранный запрос.');}catch{/* Mini App can still receive its result */}
  try{const job=await this.execute(String(r.user_id),{category:r.category,prompt:r.prompt,requestId:r.request_id},r.channel==='chat');await this.db(`access_requests?id=eq.${r.id}`,'PATCH',{job_id:job.id});}
  catch(e){const text=e instanceof AppError?e.message:'Не удалось выполнить запрос. Попробуйте выбрать раздел ещё раз.';await this.db(`access_requests?id=eq.${r.id}`,'PATCH',{error_message:text.slice(0,500)});await this.send(String(r.user_id),text,true);}
 }
 async update(body:any){
  const cb=body.callback_query,msg=cb?.message||body.message,person=cb?.from||msg?.from;
  if(!person||!Number.isSafeInteger(person.id)||person.id<=0||msg?.chat?.type!=='private'||msg.chat.id!==person.id)return;
  const user:User={id:String(person.id),first_name:String(person.first_name||'').slice(0,100),last_name:String(person.last_name||'').slice(0,100),username:String(person.username||'').slice(0,64)};
  const data=String(cb?.data||'');if(cb?.id){try{await this.tg('answerCallbackQuery',{callback_query_id:cb.id});}catch{/* stale callbacks do not grant access */}}
  const decision=parseDecision(data,user.id,String(msg.chat.id),this.admin);
  if(decision){await this.decide(decision.id,msg.message_id,decision.allow);return;}
  if(!cb&&/^\/start(?:\s|$)/.test(msg.text||'')){await this.send(user.id,'Добро пожаловать! Откройте Mini App и выберите услугу. При первом запросе владелец подтвердит доступ.',true);return;}
  if(!data.startsWith('section:'))return;
  await this.send(user.id,'Разделы перенесены в Mini App. Откройте приложение и выберите услугу там.',true);
 }
 async deliver(id:string){
  const d=await this.db('rpc/claim_chat_delivery','POST',{p_job:id});if(!d)return;
  try{const rows=await this.db(`jobs?id=eq.${id}&select=status,error_message,results(response_json)&limit=1`),j=rows[0];if(!j||!['completed','failed'].includes(j.status))return;
   const a=Array.isArray(j.results)?j.results[0]?.response_json:j.results?.response_json;
   const parts=telegramChunks(j.status==='failed'?j.error_message:answerText(a));
   let sent=d.parts_sent;for(;sent<parts.length&&sent<d.parts_sent+3;sent++){await this.send(String(d.chat_id),parts[sent],sent===parts.length-1);await this.db(`chat_deliveries?job_id=eq.${id}`,'PATCH',{parts_sent:sent+1});if(sent+1<parts.length)await new Promise(r=>setTimeout(r,1100));}
   if(sent>=parts.length)await this.db(`chat_deliveries?job_id=eq.${id}`,'PATCH',{done:true});
  }finally{await this.db(`chat_deliveries?job_id=eq.${id}`,'PATCH',{lease_until:null});}
 }
 async flush(){const rows=await this.db('chat_deliveries?done=eq.false&select=job_id,jobs!inner(status)&jobs.status=in.(completed,failed)&order=created_at&limit=2');for(const row of rows){try{await this.deliver(row.job_id);}catch{/* next heartbeat retries delivery without re-running the model */}}}
}
