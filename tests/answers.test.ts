import {it,expect} from 'vitest';
import {demoAnswer,fetchWeather,formatWeather} from '../shared/answers.ts';
import {parseCreate,categories} from '../shared/contracts.ts';
it('marks every demo as demonstration, without fabricated sources',()=>{for(const c of categories){const a=demoAnswer(c);expect(a.mode).toBe('demo');expect(a.body).toContain('Демонстрационный режим');expect(a.sources).toEqual([]);}});
it('validates category, prompt and idempotency ID',()=>{
 const data={category:'ai',prompt:'Пример',requestId:'94afc824-36d4-46d9-b9ef-772e27470061'};
 expect(parseCreate(data).prompt).toBe('Пример');
 expect(()=>parseCreate({...data,prompt:'a'.repeat(1001)})).toThrow();
 expect(()=>parseCreate({...data,category:'shell'})).toThrow();
 expect(()=>parseCreate({...data,requestId:'../other'})).toThrow();
});
const raw={current:{time:'2026-11-20T12:00',temperature_2m:4,apparent_temperature:1,weather_code:3,relative_humidity_2m:80,wind_speed_10m:12,wind_direction_10m:180},daily:{time:['2026-11-20'],temperature_2m_min:[0],temperature_2m_max:[6],precipitation_probability_max:[70],sunrise:['2026-11-20T08:00'],sunset:['2026-11-20T16:30']}};
it('formats actual fields, clothing and provenance',()=>{const a=formatWeather(raw);expect(a.mode).toBe('live');expect(a.items[0].summary).toContain('4 °C');expect(a.items[1].details).toContain('70 %');expect(a.items[2].summary).toContain('зонт');expect(a.sources[0].url).toBe('https://open-meteo.com/');});
it('does not invent missing values',()=>{const a=formatWeather({...raw,current:{time:raw.current.time,temperature_2m:4}});expect(a.items[0].summary).toContain('нет данных');});
it('rejects wrong-day and missing weather',()=>{expect(()=>formatWeather({})).toThrow();expect(()=>formatWeather({...raw,daily:{...raw.daily,time:['2026-11-19']}})).toThrow();});
it('bounds network retries and reports failure',async()=>{let calls=0;const f=(async()=>{calls++;throw Error('offline');}) as typeof fetch;await expect(fetchWeather(f)).rejects.toMatchObject({code:'WEATHER'});expect(calls).toBe(2);});
