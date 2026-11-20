"""App-owned Windows DPAPI storage; never reads browser or ChatGPT files."""
import ctypes
import json
import os
import threading
from pathlib import Path

DATA=Path(os.environ.get('LOCALAPPDATA',str(Path.home())))/'WhatsInteresting'
DATA.mkdir(parents=True,exist_ok=True)
MODEL_LOCK=threading.Lock()

class Blob(ctypes.Structure):
    _fields_=[('size',ctypes.c_uint32),('data',ctypes.POINTER(ctypes.c_ubyte))]

def crypt(value,decrypt=False):
    buf=ctypes.create_string_buffer(value);src=Blob(len(value),ctypes.cast(buf,ctypes.POINTER(ctypes.c_ubyte)));dst=Blob()
    fn=ctypes.windll.crypt32.CryptUnprotectData if decrypt else ctypes.windll.crypt32.CryptProtectData
    if not fn(ctypes.byref(src),None,None,None,None,1,ctypes.byref(dst)):raise OSError('Хранилище Windows недоступно')
    try:return ctypes.string_at(dst.data,dst.size)
    finally:ctypes.windll.kernel32.LocalFree(dst.data)

def protect(value):return crypt(value.encode('utf-8'))
def unprotect(value):return crypt(value,True).decode('utf-8')
STORE_LOCK=threading.RLock()
def load(name,default=None):
    with STORE_LOCK:
        p=DATA/name
        return json.loads(unprotect(p.read_bytes())) if p.exists() else (default if default is not None else {})
def save(name,value):
    with STORE_LOCK:
        p=DATA/name;tmp=DATA/(name+'.tmp');tmp.write_bytes(protect(json.dumps(value,ensure_ascii=False)));tmp.replace(p)

DEFAULTS={'endpoint':'https://igwvbcmpkipcoowzsaiu.supabase.co/functions/v1/telegram-app','model':'gpt-6-luna','timeout':300,'daily_limit':12,'web_search':True,'autostart':False,'minimized':False}
def settings():return {**DEFAULTS,**load('worker-settings.bin')}
def log(message):
    # Accept only application messages, never tokens, response headers or prompts.
    p=DATA/'worker.log'
    with STORE_LOCK:
        if p.exists() and p.stat().st_size>500000:p.replace(DATA/'worker.previous.log')
        from datetime import datetime,timezone
        with p.open('a',encoding='utf-8') as f:f.write(datetime.now(timezone.utc).isoformat()+' '+message+'\n')
