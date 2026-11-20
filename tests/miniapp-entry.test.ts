import {describe,it,expect} from 'vitest';
import {Access} from '../supabase/functions/telegram-app/access.ts';
describe('Mini App only entry',()=>{
 const app=new Access(async()=>[], 'test-only-token','11','https://test.supabase.co',async()=>{throw Error('chat execution forbidden');});
 it('offers exactly one Mini App button with no chat section callbacks',()=>{const buttons=app.menu().inline_keyboard.flat();expect(buttons).toHaveLength(1);expect(buttons[0]).toMatchObject({web_app:{url:'https://maxhandhunt-hub.github.io/whats-interesting-telegram/'}});expect(buttons.some(x=>'callback_data' in x)).toBe(false);});
 it('old chat section buttons only redirect to Mini App',async()=>{let sent='';app.send=async(_user,text)=>{sent=text;return true;};app.tg=async()=>true;await app.update({callback_query:{id:'c',from:{id:22},data:'section:politics',message:{message_id:80,chat:{id:22,type:'private'}}}});expect(sent).toContain('Mini App');});
});
