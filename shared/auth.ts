import {AppError} from './contracts.ts';
const enc=new TextEncoder();
async function hmac(key:Uint8Array,data:string){
 const imported=await crypto.subtle.importKey('raw',new Uint8Array(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return new Uint8Array(await crypto.subtle.sign('HMAC',imported,enc.encode(data)));
}
export async function verifyTelegramUser(initData:unknown,token:string,allowed:string,now=Math.floor(Date.now()/1000)){
 if(!token||!/^\d+$/.test(allowed))throw new AppError('CONFIG','Сервер не настроен: добавьте секреты Telegram в Supabase.',503);
 if(typeof initData!=='string'||!initData||initData.length>8192)throw new AppError('AUTH','Откройте приложение через кнопку меню Telegram-бота.',401);
 const params=new URLSearchParams(initData),seen=new Set<string>();
 for(const [key] of params){if(seen.has(key))throw new AppError('AUTH','Некорректная авторизация Telegram.',401);seen.add(key);}
 const hash=params.get('hash')||'';
 if(!/^[0-9a-f]{64}$/.test(hash))throw new AppError('AUTH','Подпись Telegram не подтверждена.',401);
 params.delete('hash');
 const check=[...params.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${k}=${v}`).join('\n');
 const secret=await hmac(enc.encode('WebAppData'),token),digest=await hmac(secret,check);
 let diff=0;for(let i=0;i<32;i++)diff|=digest[i]^parseInt(hash.slice(i*2,i*2+2),16);
 if(diff!==0)throw new AppError('AUTH','Подпись Telegram не подтверждена.',401);
 const date=Number(params.get('auth_date'));
 if(!Number.isInteger(date)||date<=0||now-date>3600||date-now>30)throw new AppError('EXPIRED','Авторизация истекла. Закройте Mini App и откройте его заново.',401);
 let user;try{user=JSON.parse(params.get('user')||'null');}catch{throw new AppError('AUTH','Некорректный пользователь Telegram.',401);}
 if(!user||!Number.isSafeInteger(user.id)||user.id<=0)throw new AppError('AUTH','Некорректный пользователь Telegram.',401);
 return {id:String(user.id),first_name:String(user.first_name||'').slice(0,100),last_name:String(user.last_name||'').slice(0,100),username:String(user.username||'').slice(0,64)};
}

export async function verifyTelegram(initData:unknown,token:string,allowed:string,now=Math.floor(Date.now()/1000)){
 const user=await verifyTelegramUser(initData,token,allowed,now);
 if(user.id!==allowed)throw new AppError('FORBIDDEN','Доступ требует разрешения владельца бота.',403);
 return user.id;
}
