"""Bounded RSS collection and public article verification. No paywall bypass."""
import calendar
import concurrent.futures
import hashlib
import html
import json
import re
from datetime import datetime,timezone
from html.parser import HTMLParser
from urllib.parse import urlparse,urlunparse,parse_qsl,urlencode
from zoneinfo import ZoneInfo
import feedparser
import requests

TZ=ZoneInfo('Europe/Moscow')
FEEDS={
 'politics':['https://feeds.bbci.co.uk/news/world/rss.xml','https://www.theguardian.com/world/rss','https://tass.ru/rss/v2.xml','https://news.un.org/feed/subscribe/en/news/all/rss.xml'],
 'ai':['https://openai.com/news/rss.xml','https://blog.google/technology/ai/rss/','https://www.microsoft.com/en-us/research/feed/','https://huggingface.co/blog/feed.xml'],
 'other':['https://www.nasa.gov/feed/','https://www.sciencedaily.com/rss/top/science.xml','https://feeds.bbci.co.uk/news/science_and_environment/rss.xml','https://www.theguardian.com/culture/rss','https://www.theguardian.com/business/rss']}
DOMAINS=('bbc.co.uk','bbci.co.uk','bbc.com','theguardian.com','tass.ru','ria.ru','interfax.ru','kremlin.ru','government.ru','mid.ru','un.org','europa.eu','reuters.com','apnews.com','axios.com','openai.com','google.com','blog.google','deepmind.google','anthropic.com','microsoft.com','ai.meta.com','about.fb.com','huggingface.co','github.com','api.github.com','qwen.ai','qwenlm.github.io','deepseek.com','nasa.gov','esa.int','sciencedaily.com','nature.com','science.org','phys.org','nplus1.ru','elementy.ru')
RELEASE_REPOS=('openai/codex','anthropics/claude-code','google-gemini/gemini-cli','QwenLM/Qwen-Agent','huggingface/transformers')

def canonical(url):
    p=urlparse(url)
    host=(p.hostname or '').lower()
    if p.scheme!='https' or p.username or p.password or p.port not in (None,443) or not any(host==d or host.endswith('.'+d) for d in DOMAINS):return ''
    if len(url)>2000:return ''
    query=urlencode([(k,v) for k,v in parse_qsl(p.query) if not k.startswith('utm_') and k not in ('fbclid','gclid')])
    return urlunparse(('https',host,p.path or '/',p.params,query,''))

def today(value,now=None):
    try:
        dt=datetime.fromisoformat(str(value).replace('Z','+00:00'))
        if dt.tzinfo is None:dt=dt.replace(tzinfo=TZ)
        now=now or datetime.now(timezone.utc)
        return dt.astimezone(TZ).date()==now.astimezone(TZ).date() and dt<=now
    except (ValueError,TypeError):return False

def fetch_public(url,limit=600000):
    url=canonical(url)
    if not url:raise ValueError('Unsupported source URL')
    for _ in range(4):
        r=requests.get(url,headers={'User-Agent':'WhatsInterestingPersonalNews/0.2'},timeout=(8,12),allow_redirects=False,stream=True)
        try:
            if r.status_code in (301,302,303,307,308):
                from urllib.parse import urljoin
                url=canonical(urljoin(url,r.headers.get('Location','')))
                if not url:raise ValueError('Unsafe redirect')
                continue
            r.raise_for_status();buf=bytearray()
            for chunk in r.iter_content(16384):
                buf.extend(chunk)
                if len(buf)>limit:break
            return bytes(buf[:limit]),url
        finally:r.close()
    raise ValueError('Too many redirects')

def clean(value):return re.sub(r'\s+',' ',html.unescape(re.sub('<[^>]+>',' ',value or ''))).strip()

def collect(category):
    def read(url):
        try:
            content,_=fetch_public(url,2000000);feed=feedparser.parse(content);items=[]
            for entry in feed.entries[:100]:
                stamp=entry.get('published_parsed');link=canonical(entry.get('link',''))
                if not stamp or not link:continue
                published=datetime.fromtimestamp(calendar.timegm(stamp),timezone.utc).isoformat()
                if not today(published):continue
                title=clean(entry.get('title',''))[:300]
                if category=='politics' and 'tass.ru' in url and not re.search('путин|президент|министр|мид|кремл|правительств|дипломат|переговор|санкци|выбор|оон|нато|госдум|сенат|евросоюз|трамп|зеленьск|сша|украин|израил',title,re.I):continue
                if category=='other' and re.search(r'OpenAI|Anthropic|Claude|ChatGPT|Gemini|artificial intelligence|\bAI\b|Trump|Putin|election|parliament|sanction',title,re.I):continue
                items.append({'id':hashlib.sha256(link.encode()).hexdigest()[:12],'url':link,'title':title,'publishedAt':published,'excerpt':clean(entry.get('summary',''))[:1000],'feed':url})
            return items[:25]
        except (requests.RequestException,ValueError):return []
    items={};titles=set()
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for group in pool.map(read,FEEDS[category]):
            for item in group:
                title=re.sub(r'\W+','',item['title'].lower())
                if title in titles:continue
                titles.add(title);items[item['url']]=item
    if category=='ai':
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            for group in pool.map(releases,RELEASE_REPOS):
                for item in group:items[item['url']]=item
    return list(items.values())[:60]

def releases(repo):
    try:
        content,_=fetch_public('https://api.github.com/repos/'+repo+'/releases?per_page=5',2000000);data=json.loads(content);out=[]
        if not isinstance(data,list):return []
        for release in data:
            published=release.get('published_at');link=canonical(release.get('html_url',''))
            if not link or release.get('draft') or release.get('prerelease') or not today(published):continue
            out.append({'id':hashlib.sha256(link.encode()).hexdigest()[:12],'url':link,'title':repo+' — '+str(release.get('name',release.get('tag_name',''))),'publishedAt':published,'excerpt':clean(release.get('body',''))[:1800],'feed':'https://api.github.com/repos/'+repo+'/releases','kind':'official_release'})
        return out
    except (requests.RequestException,ValueError):return []

class Metadata(HTMLParser):
    def __init__(self):super().__init__();self.dates=[];self.text=[];self.in_ld=False;self.ld=[];self.hidden=0;self.in_title=False;self.title=[]
    def handle_starttag(self,tag,attrs):
        a=dict(attrs)
        if tag=='meta' and a.get('property',a.get('name','')).lower() in ('article:published_time','datepublished','pubdate','publish-date','date','dc.date.issued'):self.dates.append(a.get('content',''))
        if tag=='time' and a.get('datetime'):self.dates.append(a['datetime'])
        if tag=='title':self.in_title=True
        if tag in ('script','style'):self.hidden+=1
        if tag=='script' and a.get('type')=='application/ld+json':self.in_ld=True
    def handle_endtag(self,tag):
        if tag=='title':self.in_title=False
        if tag=='script':self.in_ld=False
        if tag in ('script','style'):self.hidden=max(0,self.hidden-1)
    def handle_data(self,data):
        if self.in_ld:self.ld.append(data)
        if self.in_title:self.title.append(data)
        if not self.hidden:self.text.append(data)
    def published(self):
        def walk(obj):
            if isinstance(obj,dict):
                if isinstance(obj.get('datePublished'),str):self.dates.insert(0,obj['datePublished'])
                for v in obj.values():walk(v)
            elif isinstance(obj,list):
                for v in obj:walk(v)
        for value in self.ld:
            try:walk(json.loads(value))
            except ValueError:pass
        for value in self.dates:
            try:datetime.fromisoformat(value.replace('Z','+00:00'));return value
            except (ValueError,AttributeError):continue
        return None

ROBOTS={}
def robots_allowed(url):
    from urllib.robotparser import RobotFileParser
    host=urlparse(url).hostname
    if host not in ROBOTS:
        parser=RobotFileParser()
        try:content,_=fetch_public('https://'+host+'/robots.txt',150000);parser.parse(content.decode('utf-8',errors='replace').splitlines());ROBOTS[host]=parser
        except requests.HTTPError as e:ROBOTS[host]=True if e.response is not None and e.response.status_code==404 else False
        except (requests.RequestException,ValueError):ROBOTS[host]=False
    parser=ROBOTS[host]
    return parser if isinstance(parser,bool) else parser.can_fetch('WhatsInterestingPersonalNews',url)

def verify(url,candidate=None):
    """Return only reachable current-day publication data; otherwise no source."""
    try:
        url=canonical(url)
        if not url or not robots_allowed(url):return None
        content,final=fetch_public(url);parser=Metadata();parser.feed(content.decode('utf-8',errors='replace'))
        # Prefer article publication metadata over RSS (an updated RSS item can be old).
        published=parser.published() or (candidate or {}).get('publishedAt')
        if not published or not today(published):return None
        title=(candidate or {}).get('title') or clean(' '.join(parser.title))
        text=clean(' '.join(parser.text))
        return {'url':final,'title':title[:300],'publishedAt':published,'excerpt':(candidate or {}).get('excerpt') or text[:1800]}
    except (requests.RequestException,ValueError):return None
