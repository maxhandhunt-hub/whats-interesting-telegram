"""Single-threaded work queue with an independent lease heartbeat."""
import json
import secrets
import threading
import time
import requests
from . import secure_store as store,oauth
from .inference import Inference,PlanError
from .news import News

def worker_key():
    record=store.load('worker-access.bin')
    if not record.get('token'):record={'token':secrets.token_urlsafe(32)};store.save('worker-access.bin',record)
    return record['token']

class QueueClient:
    def __init__(self,cfg):self.cfg=cfg
    def call(self,action,**data):
        endpoint=self.cfg['endpoint']
        if endpoint!='https://igwvbcmpkipcoowzsaiu.supabase.co/functions/v1/telegram-app':raise RuntimeError('Неподтверждённый адрес очереди')
        try:
            r=requests.post(endpoint,json={'action':'worker_'+action,**data},headers={'Authorization':'Bearer '+worker_key()},timeout=(10,20))
            if not r.ok:
                if r.status_code==401:raise RuntimeError('Ключ локального обработчика не принят Supabase')
                raise RuntimeError('Очередь Supabase временно недоступна')
            return r.json()
        except requests.RequestException:raise RuntimeError('Нет соединения с Supabase. Ожидаю восстановления сети.') from None

class Worker:
    def __init__(self,cfg,notify=lambda kind,value:None):
        self.cfg=cfg;self.notify=notify;self.client=QueueClient(cfg);self.model=Inference(cfg['model'],cfg['timeout']);self.news=News(self.model,lambda value:self.notify('stage',value));self.halt=threading.Event();self.active=None;self.threads=[];self.paused=False
    def start(self):
        if self.threads:return
        if not oauth.read().get('access_token'):raise RuntimeError('Сначала войдите через ChatGPT')
        self.client.call('ping',ready=True,model=self.cfg['model'])
        for target in (self._heartbeat,self._work):
            t=threading.Thread(target=target,daemon=True);self.threads.append(t);t.start()
    def stop(self):
        self.halt.set();self.model.stop()
        try:self.client.call('ping',ready=False,model=self.cfg['model'])
        except RuntimeError:pass
    def _heartbeat(self):
        while not self.halt.wait(20):
            if self.paused:continue
            data={'ready':not self.paused,'model':self.cfg['model']}
            if self.active:data.update(jobId=self.active['id'],lease=self.active['lease'])
            try:self.client.call('ping',**data);self.notify('supabase','Supabase: соединение установлено')
            except RuntimeError as e:self.notify('error',str(e))
    def _work(self):
        while not self.halt.is_set():
            if self.paused:self.halt.wait(5);continue
            try:
                job=self.client.call('claim').get('job')
                if not job:self.halt.wait(12);continue
                if self.halt.is_set():return
                self.active=job;self.notify('job',job['category']);store.log('Задание получено: '+job['category'])
                answer=None;error=None
                try:answer=self.news.generate(job['category'],job['prompt'],search=self.cfg['web_search'],daily_limit=self.cfg['daily_limit'])
                except PlanError as e:
                    error=str(e);store.save('worker-diagnostic.bin',{'status':e.status,'code':e.code,'shape':e.shape,'request_id':e.request_id})
                    if e.status in (401,403,429) or 'usage_' in e.code or e.code=='subscription_sharing_user_unavailable':self.paused=True;self.notify('chatgpt','ChatGPT: требуется проверка входа или лимита')
                except Exception as e:
                    error=str(e) if isinstance(e,RuntimeError) else 'Локальная обработка не выполнена. Подробности доступны в журнале состояния.'
                    if any(text in error for text in ('Вход ChatGPT истёк','Нажмите «Войти','Не разрешено использование','дневной лимит')):self.paused=True
                payload={'jobId':job['id'],'lease':job['lease'],'answer':answer,'error':error}
                if self.paused:
                    try:self.client.call('ping',ready=False,model=self.cfg['model'])
                    except RuntimeError:pass
                delivered=False
                for attempt in range(3):
                    try:self.client.call('complete',**payload);delivered=True;break
                    except RuntimeError:self.halt.wait(2+attempt*2)
                if not delivered:self.notify('error','Не удалось сохранить результат в Supabase. Задание будет повторно доступно после истечения аренды.')
                elif error:self.notify('error',error);store.log('Задание завершено с ошибкой')
                else:self.notify('done',('Кэш' if answer.get('cacheHit') else 'ChatGPT')+' • '+job['category']);store.log('Задание выполнено: '+job['category'])
                self.active=None
            except RuntimeError as e:self.notify('error',str(e));self.halt.wait(10)
