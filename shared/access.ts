import {isUuid,names,type Category,type Answer} from './contracts.ts';
export function parseDecision(data:string,user:string,chat:string,owner:string){
 if(user!==owner||chat!==owner)return null;
 const [prefix,action,id,...extra]=data.split(':');
 if(prefix!=='access'||!['allow','deny'].includes(action)||extra.length||!isUuid(id||''))return null;
 return {id,allow:action==='allow'};
}
export function accessText(r:{first_name:string;last_name:string;username:string;user_id:string;category:string}){
 const clean=(s:string)=>s.replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,200);
 return `Запрос доступа\nИмя: ${clean(r.first_name+' '+r.last_name).trim()||'не указано'}\nНикнейм: ${r.username?'@'+clean(r.username):'не указан'}\nTelegram ID: ${r.user_id}\nРаздел: ${names[r.category as Category]}\n\nРазрешить постоянный доступ к четырём разделам?`;
}
export function telegramChunks(text:string){
 const out:string[]=[];let part='';for(const char of text){if(part.length+char.length>3500){out.push(part);part='';}part+=char;}if(part)out.push(part);return out;
}
export function answerText(a:Answer){return [a.title,a.body,...a.items.map((x,i)=>`${i+1}. ${x.title}\n${x.summary}${x.details?'\n'+x.details:''}${x.sources?.length?'\n'+x.sources.map(s=>s.url).join('\n'):''}`),'Источники:\n'+a.sources.map(s=>s.title+'\n'+s.url).join('\n'),'Сформировано: '+new Date(a.createdAt).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})+' МСК'].join('\n\n');}
