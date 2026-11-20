import {describe,it,expect} from 'vitest';
import * as a from '../shared/access.ts';
describe('Telegram access callbacks',()=>{
 it('only accepts decisions from owner in private owner chat',()=>{expect(a.parseDecision('access:allow:550e8400-e29b-41d4-a716-446655440000','22','22','11')).toBeNull();expect(a.parseDecision('access:allow:550e8400-e29b-41d4-a716-446655440000','11','22','11')).toBeNull();expect(a.parseDecision('access:allow:550e8400-e29b-41d4-a716-446655440000','11','11','11')).toEqual({id:'550e8400-e29b-41d4-a716-446655440000',allow:true});});
 it('rejects malformed or unknown decision actions',()=>{for(const x of ['access:grant:550e8400-e29b-41d4-a716-446655440000','access:deny:bad','weather'])expect(a.parseDecision(x,'11','11','11')).toBeNull();});
 it('shows name and nickname, including missing username',()=>{expect(a.accessText({first_name:'Анна',last_name:'Тест',username:'anna',user_id:'22',category:'ai'})).toContain('Анна Тест\nНикнейм: @anna');expect(a.accessText({first_name:'Анна',last_name:'',username:'',user_id:'22',category:'weather'})).toContain('Никнейм: не указан');});
 it('splits long Unicode Telegram messages without losing characters',()=>{const s='Привет 😀\n'.repeat(1300);const chunks=a.telegramChunks(s);expect(chunks.join('')).toBe(s);expect(chunks.every(x=>x.length<=3500)).toBe(true);expect(chunks.some(x=>/[\uD800-\uDBFF]$/.test(x))).toBe(false);});
});
