"""Official Sign in with ChatGPT, direct Responses with hosted web search."""
import base64
import hashlib
import json
import secrets
import threading
import time
import uuid
import webbrowser
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlencode, urlparse, parse_qs
import requests
from . import secure_store as core

AUTH='https://auth.openai.com'
RESOURCE='https://api.openai.com/v1'
SESSION_LOCK=threading.Lock()

def read():
    p=core.DATA/'chatgpt.bin'
    return json.loads(core.unprotect(p.read_bytes())) if p.exists() else {}

def save(record):
    p=core.DATA/'chatgpt.tmp'; p.write_bytes(core.protect(json.dumps(record))); p.replace(core.DATA/'chatgpt.bin')

def host_id():
    p=core.DATA/'host-id.txt'
    if not p.exists(): p.write_text('urn:uuid:'+str(uuid.uuid4()),'ascii')
    return p.read_text('ascii')

def sign_in(new=False):
    import jwt
    old={} if new else read()
    state=secrets.token_urlsafe(32); nonce=secrets.token_urlsafe(32); verifier=secrets.token_urlsafe(48)
    challenge=base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
    result={}
    class Callback(BaseHTTPRequestHandler):
        def log_message(self,*args): pass
        def do_GET(self):
            parsed=urlparse(self.path); values={k:v[0] for k,v in parse_qs(parsed.query).items()}
            if parsed.path!='/auth/callback' or not secrets.compare_digest(values.get('state',''),state):
                self.send_response(400); self.end_headers(); return
            result.update(values); self.send_response(200); self.send_header('Content-Type','text/plain; charset=utf-8'); self.end_headers()
            self.wfile.write('Вернитесь в приложение. Проверяется вход ChatGPT.'.encode())
    server=HTTPServer(('127.0.0.1',0),Callback); server.timeout=1
    redirect=f'http://127.0.0.1:{server.server_port}/auth/callback'
    params=dict(client_id=old.get('client_id','dynamic_agent_client'),ext_agent_host_id=host_id(),response_type='code',redirect_uri=redirect,scope='openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',resource=RESOURCE,state=state,nonce=nonce,code_challenge_method='S256',code_challenge=challenge)
    if not old: params['agent_name_hint']="What's Interesting — Telegram News Bot"
    elif old.get('id_token'): params['id_token_hint']=old['id_token']
    try:
        webbrowser.open(AUTH+'/api/accounts/authorize?'+urlencode(params))
        until=time.monotonic()+300
        while not result and time.monotonic()<until: server.handle_request()
    finally: server.server_close()
    if not result or result.get('error'): raise RuntimeError('Вход ChatGPT не завершён или разрешение отклонено')
    client=result.get('client_id',old.get('client_id'))
    if not client or client=='dynamic_agent_client' or (old and client!=old['client_id']): raise RuntimeError('Некорректная регистрация ChatGPT')
    if not old: save({'client_id':client})
    r=requests.post(AUTH+'/api/accounts/oauth/token',data=dict(grant_type='authorization_code',client_id=client,code=result['code'],code_verifier=verifier,redirect_uri=redirect,resource=RESOURCE),timeout=30)
    if not r.ok: raise RuntimeError('ChatGPT: обмен кода не выполнен')
    tokens=r.json()
    discovery=requests.get(AUTH+'/.well-known/openid-configuration',timeout=20); discovery.raise_for_status(); config=discovery.json()
    jwks=config['jwks_uri']
    if not jwks.startswith(AUTH+'/'): raise RuntimeError('Некорректный адрес проверки подписи')
    key=jwt.PyJWKClient(jwks,timeout=20).get_signing_key_from_jwt(tokens['id_token'])
    claims=jwt.decode(tokens['id_token'],key.key,algorithms=['RS256'],audience=client,issuer=AUTH,options={'require':['exp','iat','sub','aud','iss','nonce']})
    if not secrets.compare_digest(claims['nonce'],nonce): raise RuntimeError('Не совпал nonce входа ChatGPT')
    if old.get('subject') and old['subject']!=claims['sub']: raise RuntimeError('Вход выполнен другим аккаунтом')
    if 'chatgpt.tokens.use.direct' not in tokens.get('scope','').split(): raise RuntimeError('Не разрешено использование лимита ChatGPT')
    tokens.update(client_id=client,subject=claims['sub'],email=claims.get('email',''),expires_at=time.time()+tokens.get('expires_in',3600))
    save(tokens)
    return tokens

def access_token():
    with SESSION_LOCK:
        record=read()
        if 'chatgpt.tokens.use.direct' not in record.get('scope','').split(): raise RuntimeError('Не разрешено использование лимита ChatGPT')
        if not record.get('access_token'): raise RuntimeError('Нажмите «Войти через ChatGPT» в приложении')
        if record.get('expires_at',0)>time.time()+90: return record['access_token']
        r=requests.post(AUTH+'/api/accounts/oauth/token',data=dict(grant_type='refresh_token',client_id=record['client_id'],refresh_token=record['refresh_token'],resource=RESOURCE),timeout=30)
        if not r.ok: raise RuntimeError('Вход ChatGPT истёк. Войдите заново.')
        refreshed=r.json()
        if 'scope' in refreshed and 'chatgpt.tokens.use.direct' not in refreshed['scope'].split(): raise RuntimeError('Разрешение ChatGPT отозвано')
        record.update(refreshed); record['expires_at']=time.time()+refreshed.get('expires_in',3600); save(record)
        return record['access_token']

def models():
    r=requests.get(RESOURCE+'/models',headers={'Authorization':'Bearer '+access_token()},timeout=30)
    if not r.ok: raise RuntimeError('ChatGPT: каталог моделей недоступен')
    return [(x['slug'],x.get('display_name',x['slug'])) for x in r.json().get('models',[]) if x.get('visibility')=='list' and 'astra' not in (x.get('slug','')+x.get('display_name','')).lower()]



def disconnect():
    record=read()
    save({k:v for k,v in record.items() if k in ("client_id","subject","email")})
