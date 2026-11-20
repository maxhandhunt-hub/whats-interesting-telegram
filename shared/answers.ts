import {AppError,names,type Answer,type Category} from './contracts.ts';
export function demoAnswer(category:Category,prompt='',now=new Date().toISOString()):Answer{
 const topics={weather:'Балабаново, Калужская область',politics:'Россия, международные события и дипломатия',ai:'Модели, ИИ-сервисы и автоматизация',other:'Наука, космос, технологии и открытия'}[category];
 return {title:names[category],mode:'demo',createdAt:now,body:'Демонстрационный режим. Это проверка работы приложения, а не подборка реальных новостей. ИИ и новостной поиск в этой версии не подключены.',items:[{title:'Что будет в этом разделе',summary:topics,details:'В будущей версии здесь появятся проверенные материалы с датами событий и ссылками на источники.'},{title:prompt?'Ваш запрос':'Как работает тест',summary:prompt||'Запрос проходит через Supabase, а ответ сохраняется в вашей истории.',details:'Основной результат остаётся внутри Mini App. Сообщение с ответом в Telegram-чат не отправляется.'}],sources:[]};
}
export function weatherDescription(code:number){
 if(code===0)return 'Ясно';if(code===1)return 'Преимущественно ясно';if(code===2)return 'Переменная облачность';if(code===3)return 'Пасмурно';
 if([45,48].includes(code))return 'Туман';if([51,53,55,56,57].includes(code))return 'Морось';if([61,63,65,66,67,80,81,82].includes(code))return 'Дождь';if([71,73,75,77,85,86].includes(code))return 'Снег';if([95,96,99].includes(code))return 'Гроза';return 'Условия не уточнены';
}
export function formatWeather(raw:unknown,now=new Date().toISOString()):Answer{
 const data=raw as {current?:Record<string,unknown>;daily?:Record<string,unknown[]>};
 if(!data?.current||!data.daily)throw new AppError('WEATHER','Источник погоды вернул неполные данные.',502);
 const c=data.current,d=data.daily;
 const num=(v:unknown,unit:string)=>typeof v==='number'&&Number.isFinite(v)?`${Math.round(v)}${unit}`:'нет данных';
 const day=(key:string)=>d[key]?.[0];
 const currentDate=typeof c.time==='string'?c.time.slice(0,10):'';
 if(!currentDate||day('time')!==currentDate)throw new AppError('WEATHER','Источник вернул данные за разные даты. Повторите запрос.',502);
 if(typeof c.temperature_2m!=='number'||!Number.isFinite(c.temperature_2m))throw new AppError('WEATHER','Источник не сообщил текущую температуру.',502);
 const time=(v:unknown)=>typeof v==='string'&&v.includes('T')?v.slice(11,16):'нет данных';
 const apparent=c.apparent_temperature;
 const clothing=typeof apparent!=='number'?'Подберите одежду после проверки актуальных условий.':apparent<0?'Тёплая куртка, шапка и перчатки.':apparent<10?'Куртка и закрытая обувь.':apparent<18?'Лёгкая куртка или свитер.':'Лёгкая одежда по погоде.';
 const rain=day('precipitation_probability_max');
 return {title:'Погода в Балабаново',mode:'live',createdAt:now,body:`${weatherDescription(Number(c.weather_code))}. Данные модели прогноза Open-Meteo на ${currentDate}, ${time(c.time)} по Москве. Это расчётные данные, а не показания местной метеостанции.`,items:[
 {title:'Сейчас',summary:`${num(c.temperature_2m,' °C')} · ощущается как ${num(apparent,' °C')}`,details:`Влажность: ${num(c.relative_humidity_2m,' %')}. Ветер: ${num(c.wind_speed_10m,' км/ч')}, направление ${num(c.wind_direction_10m,'°')}.`},
 {title:'Сегодня',summary:`От ${num(day('temperature_2m_min'),' °C')} до ${num(day('temperature_2m_max'),' °C')}`,details:`Максимальная вероятность осадков за день: ${num(rain,' %')}. Восход: ${time(day('sunrise'))}. Закат: ${time(day('sunset'))}. Время московское.`},
 {title:'Что надеть',summary:clothing+(typeof rain==='number'&&rain>=40?' Возьмите зонт или непромокаемую куртку.':''),details:'Рекомендация составлена по ощущаемой температуре и вероятности осадков, без использования ИИ.'}],sources:[{title:'Open-Meteo — источник прогноза',url:'https://open-meteo.com/'}]};
}
export async function fetchWeather(fetcher:typeof fetch=fetch){
 const p=new URLSearchParams({latitude:'55.18161',longitude:'36.6606',timezone:'Europe/Moscow',forecast_days:'1',current:'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m',daily:'temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset'});
 for(let attempt=0;attempt<2;attempt++){
  try{const r=await fetcher(`https://api.open-meteo.com/v1/forecast?${p}`,{signal:AbortSignal.timeout(10000)});if(r.ok)return formatWeather(await r.json());if(r.status<500&&r.status!==429)break;}catch{if(attempt===1)break;}
 }
 throw new AppError('WEATHER','Open-Meteo сейчас недоступен. Попробуйте обновить погоду через минуту.',502);
}
