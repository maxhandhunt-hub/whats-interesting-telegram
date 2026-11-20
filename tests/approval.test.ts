import {describe,it,expect} from 'vitest';
import {Access} from '../supabase/functions/telegram-app/access.ts';
const input={category:'politics' as const,prompt:'Дипломатия',requestId:'550e8400-e29b-41d4-a716-446655440000'};
function setup(){
 const notices:any[]=[],messages:any[]=[],jobs:any[]=[];let consumed=false;
 const record={id:'550e8400-e29b-41d4-a716-446655440000',user_id:22,first_name:'Анна',last_name:'Тест',username:'anna',category:'politics',prompt:'Дипломатия',request_id:input.requestId,channel:'chat',owner_message_id:80};
 const db=async(path:string,_method?:string,body?:any)=>{
  if(path==='rpc/decide_access'){if(body.p_admin!=='11'||body.p_message!==80||consumed)return null;consumed=true;return record;}
  if(path.startsWith('access_requests?'))return [];
  throw Error('Unexpected DB operation '+path);
 };
 const access=new Access(db,'test-only-token','11','https://test.supabase.co',async(user,arg,chat)=>{jobs.push({user,arg,chat});return {id:input.requestId} as any;});
 access.tg=async(method,data)=>{notices.push({method,data});return true;};
 access.send=async(user,text,menu)=>{messages.push({user,text,menu});return true;};
 return {access,notices,messages,jobs};
}
describe('approval orchestration',()=>{
 it('approval resumes original category and prompt once, deletes owner notice',async()=>{const s=setup();await s.access.decide(input.requestId,80,true);await s.access.decide(input.requestId,80,true);expect(s.jobs).toEqual([{user:'22',arg:input,chat:true}]);expect(s.notices.some(x=>x.method==='deleteMessage'&&x.data.chat_id==='11'&&x.data.message_id===80)).toBe(true);expect(s.messages.some(x=>x.user==='22'&&x.text.includes('Доступ разрешён'))).toBe(true);});
 it('denial notifies requester and never launches job',async()=>{const s=setup();await s.access.decide(input.requestId,80,false);expect(s.jobs).toEqual([]);expect(s.messages.some(x=>x.user==='22'&&x.text.includes('Доступ отклонён'))).toBe(true);});
 it('wrong owner message cannot approve a request',async()=>{const s=setup();await s.access.decide(input.requestId,81,true);expect(s.jobs).toEqual([]);expect(s.messages).toEqual([]);});
 it('forged owner callback from requester grants nothing',async()=>{const s=setup();await s.access.update({callback_query:{id:'c1',data:'access:allow:'+input.requestId,from:{id:22,first_name:'Анна'},message:{message_id:80,chat:{id:22,type:'private'}}}});expect(s.jobs).toEqual([]);expect(s.messages).toEqual([]);});
 it('rejects webhook with wrong secret or browser origin',async()=>{const s=setup();await expect(s.access.checkWebhook(new Request('https://test.invalid',{headers:{'x-telegram-bot-api-secret-token':'bad'}}))).rejects.toMatchObject({code:'WEBHOOK_AUTH'});await expect(s.access.checkWebhook(new Request('https://test.invalid',{headers:{'x-telegram-bot-api-secret-token':await s.access.secret(),origin:'https://test.invalid'}}))).rejects.toMatchObject({code:'WEBHOOK_AUTH'});});
 it('accepts matching webhook secret',async()=>{const s=setup();await expect(s.access.checkWebhook(new Request('https://test.invalid',{headers:{'x-telegram-bot-api-secret-token':await s.access.secret()}}))).resolves.toBeUndefined();});
});
