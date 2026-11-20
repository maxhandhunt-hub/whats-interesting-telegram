import {describe,it,expect} from 'vitest';
import {createHmac} from 'node:crypto';
import {verifyTelegram} from '../shared/auth.ts';
const token='test-only-secret-not-a-credential',owner='1234567',now=1800000000;
function sign(user=owner,date=now){
 const p=new URLSearchParams({auth_date:String(date),user:JSON.stringify({id:Number(user),first_name:'Тест'}),query_id:'test-query'});
 const check=[...p.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
 const key=createHmac('sha256','WebAppData').update(token).digest();
 p.set('hash',createHmac('sha256',key).update(check).digest('hex'));return p.toString();
}
describe('Telegram authorization',()=>{
 it('accepts independently signed data for owner',async()=>expect(await verifyTelegram(sign(),token,owner,now)).toBe(owner));
 it('rejects signed data from another ID',async()=>expect(verifyTelegram(sign('98765'),token,owner,now)).rejects.toMatchObject({status:403}));
 it('rejects expired data',async()=>expect(verifyTelegram(sign(owner,now-3601),token,owner,now)).rejects.toMatchObject({code:'EXPIRED'}));
 it('rejects future data',async()=>expect(verifyTelegram(sign(owner,now+31),token,owner,now)).rejects.toMatchObject({code:'EXPIRED'}));
 it('rejects tampering',async()=>expect(verifyTelegram(sign().replace('test-query','changed'),token,owner,now)).rejects.toMatchObject({code:'AUTH'}));
 it('rejects duplicate keys',async()=>expect(verifyTelegram(sign()+'&auth_date='+now,token,owner,now)).rejects.toMatchObject({code:'AUTH'}));
 it('fails closed when secrets are missing',async()=>expect(verifyTelegram(sign(),'',owner,now)).rejects.toMatchObject({status:503}));
 it('does not authorize empty browser data',async()=>expect(verifyTelegram('',token,owner,now)).rejects.toMatchObject({status:401}));
});
