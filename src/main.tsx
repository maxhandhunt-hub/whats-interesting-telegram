import React,{useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {names,categories,type Category,type Job,type Answer} from '../shared/contracts.ts';
import {demoAnswer} from '../shared/answers.ts';
import {authenticatedLaunch,call,createJob} from './api.ts';
import {telegram} from './telegram.ts';
import './style.css';

const details:Record<Category,string>={weather:'Балабаново',politics:'Главные политические события',ai:'Новости искусственного интеллекта',other:'Наука, космос, технологии и другие новости'};
const date=(value:string)=>new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',dateStyle:'medium',timeStyle:'short'}).format(new Date(value));
function Icon({category}:{category:Category}){
 const ref=useRef<HTMLVideoElement>(null),base=import.meta.env.BASE_URL+'icons/'+category;
 useEffect(()=>{
  const video=ref.current!,motion=matchMedia('(prefers-reduced-motion: reduce)');
  const update=()=>{video.muted=true;if(motion.matches||document.hidden){video.pause();video.style.opacity='0';return;}if(!video.src)video.src=base+'.mp4';video.play().catch(()=>{video.style.opacity='0';});};
  const playing=()=>{if(!motion.matches&&!document.hidden)video.style.opacity='1';};
  video.addEventListener('playing',playing);motion.addEventListener('change',update);document.addEventListener('visibilitychange',update);update();
  return()=>{video.pause();video.removeEventListener('playing',playing);motion.removeEventListener('change',update);document.removeEventListener('visibilitychange',update);};
 },[base]);
 return <span className="icon" aria-hidden="true"><img src={base+'.webp'} alt="" width="256" height="256"/><video ref={ref} muted loop playsInline preload="none" poster={base+'.webp'} tabIndex={-1}/></span>;
}
function AnswerView({answer}:{answer:Answer}){
 return <article className="answer"><div className={'badge '+answer.mode}>{answer.mode==='demo'?'Демонстрационный режим':'Реальный прогноз'}</div><h2>{answer.title}</h2><time dateTime={answer.createdAt}>{date(answer.createdAt)} МСК</time><p className="answer-intro">{answer.body}</p><div className="answer-items">{answer.items.map((item,i)=><details className="answer-item" key={i}><summary><span><strong>{item.title}</strong><span>{item.summary}</span></span><span className="more">Подробнее <span aria-hidden="true">⌄</span></span></summary>{item.details&&<p>{item.details}</p>}</details>)}</div>{answer.sources.length>0&&<section className="sources"><h3>Источники</h3>{answer.sources.map(source=><a key={source.url} href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a>)}</section>}</article>;
}
function App(){
 const [screen,setScreen]=useState<'home'|'result'|'history'>('home'),[category,setCategory]=useState<Category>('weather'),[prompt,setPrompt]=useState(''),[job,setJob]=useState<Job|null>(null),[answer,setAnswer]=useState<Answer|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[history,setHistory]=useState<Job[]>([]);
 const pending=useRef<{category:Category;prompt:string;id:string}|null>(null),lock=useRef(false),generation=useRef(0);
 const home=()=>{generation.current++;setScreen('home');setError('');setBusy(false);lock.current=false;};
 useEffect(()=>{const back=telegram?.BackButton;if(!back)return;if(screen==='home')back.hide();else back.show();back.onClick(home);return()=>back.offClick(home);},[screen]);
 async function run(c:Category,text:string,retry=false){
  if(lock.current)return;
  lock.current=true;setBusy(true);setError('');setCategory(c);setScreen('result');setAnswer(null);setJob(null);
  const seq=++generation.current;
  const request=retry&&pending.current?pending.current:{category:c,prompt:text,id:crypto.randomUUID()};pending.current=request;
  try{
   if(!authenticatedLaunch){setAnswer({...demoAnswer(c,text),body:'Демонстрационный режим вне Telegram. Здесь показан только интерфейс: запрос не отправлен в Supabase и не сохранён в защищённой истории. Для реальной погоды откройте приложение через кнопку меню бота.'});return;}
   let current=await createJob(request.category,request.prompt,request.id);
   for(let i=0;(current.status==='queued'||current.status==='processing')&&i<15;i++){
    if(seq!==generation.current)return;setJob(current);await new Promise(resolve=>setTimeout(resolve,2000));
    current=(await call<{job:Job}>('status',{jobId:current.id})).job;
   }
   if(seq!==generation.current)return;
   setJob(current);
   if(current.status==='failed')throw Error(current.error_message||'Не удалось выполнить запрос.');
   if(current.status!=='completed')throw Error('Задание ещё обрабатывается. Нажмите «Повторить запрос», чтобы проверить тот же запрос.');
   if(!current.answer)throw Error('Ответ пока недоступен. Повторите запрос.');
   setAnswer(current.answer);pending.current=null;
  }catch(e){if(seq===generation.current)setError(e instanceof Error?e.message:'Не удалось выполнить запрос.');}
  finally{if(seq===generation.current){setBusy(false);lock.current=false;}}
 }
 async function openHistory(){
  if(lock.current)return;setScreen('history');setError('');setHistory([]);
  if(!authenticatedLaunch)return;setBusy(true);lock.current=true;const seq=++generation.current;
  try{const data=await call<{jobs:Job[]}>('history');if(seq===generation.current)setHistory(data.jobs);}catch(e){if(seq===generation.current)setError(e instanceof Error?e.message:'История недоступна.');}finally{if(seq===generation.current){setBusy(false);lock.current=false;}}
 }
 return <main><header><div className="brand"><span aria-hidden="true" className="brand-mark">?</span><span>Что интересного?</span><span className="version">Тестовая версия</span></div><h1>{screen==='home'?'Твой персональный информационный помощник':screen==='history'?'История запросов':names[category]}</h1>{screen==='home'&&<p className="subtitle">Выберите, о чём узнать сегодня. Ответ появится здесь.</p>}</header>
 <nav className="tabs" aria-label="Навигация"><button className={screen!=='history'?'selected':''} onClick={home} disabled={busy}>Разделы</button><button className={screen==='history'?'selected':''} onClick={openHistory} disabled={busy}>История</button></nav>
 {!authenticatedLaunch&&<aside className="notice">Вы открыли демонстрацию. Для доступа к погоде и личной истории запустите Mini App через меню Telegram-бота.</aside>}
 {screen==='home'&&<><div className="categories">{categories.map(c=><button key={c} className={'category '+c} onClick={()=>run(c,prompt)}><Icon category={c}/><span className="category-copy"><strong>{names[c]}</strong><span>{details[c]}</span></span><span className="chevron" aria-hidden="true">›</span></button>)}</div><form className="query" onSubmit={e=>{e.preventDefault();run(category,prompt);}}><label htmlFor="prompt">Свой запрос</label><p>В тестовой версии он сохранится с демонстрационным ответом. Для погоды используется выбранный город.</p><textarea id="prompt" maxLength={1000} rows={3} value={prompt} onChange={e=>setPrompt(e.target.value)} placeholder="Например: что нового в нейросетях?"/><div className="query-bottom"><select aria-label="Раздел для запроса" value={category} onChange={e=>setCategory(e.target.value as Category)}>{categories.map(c=><option key={c} value={c}>{names[c]}</option>)}</select><span className="counter">{prompt.length}/1000</span><button className="primary" type="submit">Отправить</button></div></form></>}
 {screen==='result'&&<><div className="toolbar"><button onClick={home}>‹ Назад</button><button disabled={busy} onClick={()=>run(category,prompt)}>Обновить</button></div>{busy&&<div className="loading" role="status"><span className="spinner"/><strong>{category==='weather'?'Получаю прогноз…':'Готовлю демонстрационный ответ…'}</strong><p>Оставайтесь в приложении. Ответ появится на этой странице.</p></div>}{answer&&<AnswerView answer={answer}/>}<form className="followup" onSubmit={e=>{e.preventDefault();run(category,prompt);}}><label htmlFor="followup">Запрос в этом разделе</label><textarea id="followup" rows={2} value={prompt} maxLength={1000} disabled={busy} onChange={e=>setPrompt(e.target.value)} placeholder="Необязательное уточнение"/><button type="submit" disabled={busy} className="primary">Отправить</button></form>{job&&<p className="job-meta">Запрос от {date(job.created_at)} МСК</p>}</>}
 {screen==='history'&&<><div className="toolbar"><button onClick={home}>‹ Назад</button><button onClick={openHistory} disabled={busy}>Обновить</button></div>{busy&&<p role="status">Загружаю историю…</p>}{!authenticatedLaunch?<p className="empty">Защищённая история доступна только владельцу при открытии из Telegram.</p>:!busy&&!history.length&&!error?<p className="empty">Запросов пока нет. Выберите раздел, чтобы создать первый.</p>:<div className="history-list">{history.map(item=><button className={'history-row '+item.category} key={item.id} onClick={()=>{setCategory(item.category);setPrompt(item.prompt);setJob(item);setAnswer(item.answer||null);setError(item.error_message||(item.status==='processing'||item.status==='queued'?'Задание ещё обрабатывается. Повторите запрос с его номером.':''));pending.current=null;setScreen('result');}}><span><strong>{names[item.category]}</strong><span>{item.prompt||'Запрос раздела'}</span><time>{date(item.created_at)}</time></span><span className="state">{item.status==='completed'?'Готово':item.status==='failed'?'Ошибка':'В работе'}</span></button>)}</div>}</>}
 {error&&<div role="alert" className="error"><strong>Запрос не выполнен</strong><p>{error}</p><button className="primary" disabled={busy} onClick={()=>screen==='history'?openHistory():run(pending.current?.category||category,pending.current?.prompt||prompt,Boolean(pending.current))}>Повторить запрос</button></div>}
 <footer>Время московское. Погода — Open-Meteo. Новости — демонстрационный режим.</footer></main>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
