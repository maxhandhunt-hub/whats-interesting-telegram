export const categories=['weather','politics','ai','other'] as const;
export type Category=typeof categories[number];
export const names:Record<Category,string>={weather:'Погода',politics:'Политика',ai:'Нейросети',other:'Интересное'};
export type Status='queued'|'processing'|'completed'|'failed';
export interface Source {title:string;url:string;publishedAt?:string;}
export interface Answer {title:string;mode:'live'|'demo'|'news';createdAt:string;body:string;items:{title:string;summary:string;details?:string;eventDate?:string|null;sources?:Source[]}[];sources:Source[];model?:string;cacheHit?:boolean;}
export interface Job {id:string;category:Category;prompt:string;status:Status;created_at:string;updated_at:string;completed_at:string|null;error_message:string|null;answer?:Answer;worker_online?:boolean;}
export class AppError extends Error {constructor(public code:string,message:string,public status=400){super(message);}}
export function parseCreate(value:Record<string,unknown>){
 if(!categories.includes(value.category as Category))throw new AppError('CATEGORY','Выберите один из четырёх разделов.');
 if(typeof value.prompt!=='string'||value.prompt.length>1000)throw new AppError('PROMPT','Запрос должен содержать не более 1000 символов.');
 if(typeof value.requestId!=='string'||!isUuid(value.requestId))throw new AppError('REQUEST_ID','Некорректный идентификатор запроса.');
 return {category:value.category as Category,prompt:value.prompt.trim(),requestId:value.requestId};
}
export function isUuid(value:string){return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);}
