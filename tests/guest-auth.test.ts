import {describe,it,expect} from 'vitest';
import {createHmac} from 'node:crypto';
import * as auth from '../shared/auth.ts';
const token='test-only-not-a-real-token',now=1800000000;
function signed(){const p=new URLSearchParams({auth_date:String(now),user:JSON.stringify({id:98765,first_name:'Анна',last_name:'Тест',username:'anna'})});const s=[...p].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');p.set('hash',createHmac('sha256',createHmac('sha256','WebAppData').update(token).digest()).update(s).digest('hex'));return p.toString();}
describe('signed guest identity without granting access',()=>{
 it('verifies guest identity separately from owner-only authorization',async()=>{expect(typeof (auth as any).verifyTelegramUser).toBe('function');const u=await (auth as any).verifyTelegramUser(signed(),token,'1234567',now);expect(u).toEqual({id:'98765',first_name:'Анна',last_name:'Тест',username:'anna'});});
 it('still rejects forged guest identity',async()=>{expect(typeof (auth as any).verifyTelegramUser).toBe('function');await expect((auth as any).verifyTelegramUser(signed().replace('anna','attacker'),token,'1234567',now)).rejects.toMatchObject({code:'AUTH'});});
});
