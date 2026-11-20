import {beforeAll,afterEach,it,expect,vi} from 'vitest';
let call:typeof import('../src/api.ts').call;
beforeAll(async()=>{
 vi.stubEnv('VITE_BACKEND_URL','https://igwvbcmpkipcoowzsaiu.supabase.co/functions/v1/telegram-app');
 vi.stubGlobal('window',{Telegram:{WebApp:{initData:'unit-test-data',colorScheme:'dark',themeParams:{bg_color:'#123456'},ready(){},expand(){},onEvent(){}}}});
 vi.stubGlobal('document',{documentElement:{dataset:{},style:{setProperty(){}}}});
 call=(await import('../src/api.ts')).call;
});
afterEach(()=>vi.restoreAllMocks());
it('sends original initData with POST, without tokens or unsafe identity',async()=>{
 const fetcher=vi.fn().mockResolvedValue(Response.json({authorized:true}));vi.stubGlobal('fetch',fetcher);
 expect(await call('auth')).toEqual({authorized:true});
 const [,options]=fetcher.mock.calls[0];expect(options.method).toBe('POST');
 expect(JSON.parse(options.body)).toEqual({action:'auth',initData:'unit-test-data'});
 expect(options.headers).toEqual({'Content-Type':'application/json'});
});
it('turns network failure into a retryable user-facing error',async()=>{vi.stubGlobal('fetch',vi.fn().mockRejectedValue(Error('offline')));await expect(call('auth')).rejects.toMatchObject({code:'NETWORK'});});
it('reports server authorization errors',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({error:{code:'EXPIRED',message:'Откройте заново'}},{status:401})));await expect(call('auth')).rejects.toMatchObject({code:'EXPIRED',status:401});});
it('handles incomplete server response',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('<html>error')));await expect(call('auth')).rejects.toMatchObject({code:'NETWORK'});});
