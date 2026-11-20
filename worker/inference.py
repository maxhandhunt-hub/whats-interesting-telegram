"""HTTP/SSE Responses contract for the user's ChatGPT plan only."""
import json
import threading
import time
import requests
from . import oauth,secure_store as store

MESSAGES={
 'subscription_sharing_usage_limit_exceeded':'Достигнут лимит ChatGPT для приложения. Проверьте настройки использования и повторите позже.',
 'subscription_sharing_usage_unavailable':'Сейчас невозможно проверить лимит ChatGPT. Повторите позже.',
 'subscription_sharing_user_not_eligible':'Текущий аккаунт или рабочее пространство не разрешает использование подписки.',
 'subscription_sharing_unsupported_capability':'Модель или инструмент не поддерживается этой авторизацией.',
 'subscription_sharing_invalid_user':'Подключение ChatGPT больше не подтверждено. Войдите снова.',
 'chatpass_v2_scope_not_authorized':'Не разрешено использование подписки. Войдите через ChatGPT и проверьте согласие.',
}
class PlanError(RuntimeError):
    def __init__(self,code,status=0,request_id='',shape=None,param=None):
        self.code=code;self.status=status;self.request_id=request_id;self.shape=shape or [];self.param=param
        super().__init__(MESSAGES.get(code,'ChatGPT временно недоступен. Проверьте вход, модель и лимит подписки.'))

def error_from(data,status=0,request_id=''):
    error=data.get('error') or data.get('response',{}).get('error') or (data if data.get('code') else {})
    return PlanError(error.get('code','http_'+str(status)),status,request_id,list(data.keys()),error.get('param'))

class Inference:
    def __init__(self,model,timeout=300):self.model=model;self.timeout=timeout;self.cancel=threading.Event();self.wire=None
    def stop(self):
        self.cancel.set()
        if self.wire:self.wire.close()
    def run(self,prompt,instructions='',search=False):
        if self.cancel.is_set():raise RuntimeError('Обработка остановлена пользователем')
        if 'astra' in self.model.lower():raise RuntimeError('Модель Astra не разрешена')
        catalog=oauth.models()
        if self.model not in [m[0] for m in catalog]:raise RuntimeError('Выбранная модель недоступна аккаунту. Обновите каталог в настройках.')
        if not store.MODEL_LOCK.acquire(False):raise RuntimeError('Уже выполняется другое модельное задание')
        try:return self._run(prompt,instructions,search)
        finally:store.MODEL_LOCK.release()
    def _run(self,prompt,instructions,search):
        payload={'model':self.model,'store':False,'stream':True,'input':[{'role':'user','content':prompt}]}
        if instructions:payload['instructions']=instructions
        if search:payload.update(tools=[{'type':'web_search'}],tool_choice='required')
        start=time.monotonic();items={}
        try:
            r=requests.post(oauth.RESOURCE+'/responses',headers={'Authorization':'Bearer '+oauth.access_token()},json=payload,stream=True,timeout=(20,60));self.wire=r
            if not r.ok:
                try:data=r.json()
                except ValueError:data={'unstructured':True}
                raise error_from(data,r.status_code,r.headers.get('x-request-id',''))
            for line in r.iter_lines():
                if self.cancel.is_set():raise RuntimeError('Обработка остановлена пользователем')
                if time.monotonic()-start>self.timeout:raise RuntimeError('Истекло время ожидания ChatGPT')
                if not line.startswith(b'data: ') or line[6:]==b'[DONE]':continue
                event=json.loads(line[6:]);kind=event.get('type')
                if kind=='response.output_item.done':items[event['output_index']]=event['item']
                if kind in ('error','response.failed','response.incomplete'):raise error_from(event,request_id=r.headers.get('x-request-id',''))
                if kind=='response.completed':
                    result=event['response'];output=result.get('output') or [items[i] for i in sorted(items)]
                    if result.get('status') not in (None,'completed'):raise RuntimeError('ChatGPT не завершил ответ')
                    searched=any(x.get('type')=='web_search_call' and x.get('status','completed')=='completed' for x in output)
                    if search and not searched:raise RuntimeError('ChatGPT не подтвердил выполнение веб-поиска')
                    texts=[];links=[]
                    for item in output:
                        if item.get('type')!='message':continue
                        for content in item.get('content',[]):
                            if content.get('type')=='output_text':
                                texts.append(content['text'])
                                links.extend(a['url'] for a in content.get('annotations',[]) if a.get('type')=='url_citation' and a.get('url','').startswith('https://'))
                    if not texts:raise RuntimeError('ChatGPT вернул пустой ответ')
                    return {'text':'\n'.join(texts),'citations':list(dict.fromkeys(links)),'searched':searched,'model':self.model,'usage':result.get('usage',{})}
            raise RuntimeError('Поток ChatGPT оборвался до response.completed')
        finally:
            if self.wire:self.wire.close();self.wire=None
