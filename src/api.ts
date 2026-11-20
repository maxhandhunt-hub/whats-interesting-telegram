import {AppError,type Category,type Job} from '../shared/contracts.ts';
import {telegram} from './telegram.ts';
export const endpoint=import.meta.env.VITE_BACKEND_URL||'';
export const authenticatedLaunch=Boolean(telegram?.initData);
export async function call<T>(action:string,body:Record<string,unknown>={}):Promise<T>{
 if(!authenticatedLaunch)throw new AppError('AUTH','Откройте приложение через меню Telegram-бота.');
 if(!/^https:\/\/[a-z0-9]+\.supabase\.co\/functions\/v1\/telegram-app$/.test(endpoint))throw new AppError('CONFIG','Адрес сервера ещё не настроен.');
 let response:Response;
 try{response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,action,initData:telegram!.initData}),signal:AbortSignal.timeout(25000)});}catch{throw new AppError('NETWORK','Не удалось дождаться сервера. Проверьте интернет и нажмите «Повторить запрос». Номер запроса сохранён — дубликат не создастся.');}
 let data;try{data=await response.json();}catch{throw new AppError('NETWORK','Сервер вернул неполный ответ. Повторите запрос.');}
 if(!response.ok)throw new AppError(data.error?.code||'SERVER',data.error?.message||'Сервис временно недоступен.',response.status);
 return data as T;
}
export interface AccessState {id:string;status:'pending'|'approved'|'denied'|'expired';job_id?:string|null;error_message?:string|null;}
export async function requestJob(category:Category,prompt:string,requestId:string){return await call<{job?:Job;access?:AccessState}>('create',{category,prompt,requestId});}
export async function createJob(category:Category,prompt:string,requestId:string){const data=await requestJob(category,prompt,requestId);if(!data.job)throw new AppError('ACCESS_PENDING','Заявка отправлена владельцу. Дождитесь решения.');return data.job;}
