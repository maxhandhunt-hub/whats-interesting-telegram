import json
import unittest
from datetime import datetime,timezone
from unittest.mock import patch,MagicMock
from worker import sources,secure_store as store
from worker.news import News,cache_key
from worker.inference import Inference,PlanError

class Sources(unittest.TestCase):
    def test_all_configured_feeds_pass_source_policy(self):
        for feeds in sources.FEEDS.values():
            for url in feeds:self.assertTrue(sources.canonical(url),url)
    def test_moscow_day_and_future(self):
        now=datetime(2026,11,20,0,30,tzinfo=timezone.utc)
        self.assertTrue(sources.today('2026-11-19T23:30:00Z',now))
        self.assertFalse(sources.today('2026-11-19T12:00:00Z',now))
        self.assertFalse(sources.today('2026-11-20T01:00:00Z',now))
    def test_urls_are_public_allowlisted_https(self):
        for url in ['http://bbc.com/news/x','https://127.0.0.1/x','https://bbc.com.evil.test/x','https://user:pw@bbc.com/x','https://bbc.com:8080/x']:
            self.assertEqual(sources.canonical(url),'')
        self.assertEqual(sources.canonical('https://www.bbc.com/news/a?utm_source=x#fragment'),'https://www.bbc.com/news/a')
        self.assertTrue(sources.canonical('https://blog.google/technology/ai/rss/'))
    def test_metadata_parses_datepublished(self):
        p=sources.Metadata();p.feed('<script type="application/ld+json">{"datePublished":"2026-11-20T09:00:00+03:00"}</script>')
        self.assertIn('2026-11-20',p.ld[0]);self.assertEqual(p.text,[])
    def test_old_article_cannot_become_new_from_rss_update(self):
        raw=b'<meta property="article:published_time" content="2000-01-01T00:00:00Z">'
        with patch('worker.sources.fetch_public',return_value=(raw,'https://www.bbc.com/news/article')),patch('worker.sources.robots_allowed',return_value=True):
            self.assertIsNone(sources.verify('https://www.bbc.com/news/article',{'publishedAt':datetime.now(timezone.utc).isoformat()}))
    def test_cache_key_has_moscow_day(self):
        day1=datetime(2026,11,19,20,59,tzinfo=timezone.utc);day2=datetime(2026,11,19,21,1,tzinfo=timezone.utc)
        self.assertNotEqual(cache_key('ai','',day1),cache_key('ai','',day2))

class InferenceContract(unittest.TestCase):
    def test_stop_before_collection_cannot_start_model(self):
        model=Inference('gpt-6-luna');model.stop()
        with patch('worker.inference.oauth.models') as catalog:
            with self.assertRaises(RuntimeError):model.run('should not run')
        catalog.assert_not_called()
    def wire(self,events):
        wire=MagicMock();wire.ok=True;wire.iter_lines.return_value=[b'data: '+json.dumps(e).encode() for e in events];return wire
    def test_completion_from_stream_items_and_no_api_key_billing_fields(self):
        events=[{'type':'response.output_item.done','output_index':0,'item':{'type':'message','content':[{'type':'output_text','text':'ok'}]}},{'type':'response.completed','response':{'status':'completed','output':[]}}]
        with patch('worker.inference.oauth.models',return_value=[('gpt-6-luna','Luna')]),patch('worker.inference.oauth.access_token',return_value='unit-test-oauth'),patch('worker.inference.requests.post',return_value=self.wire(events)) as send:
            result=Inference('gpt-6-luna').run('test')
        self.assertEqual(result['text'],'ok');payload=send.call_args.kwargs['json'];self.assertFalse(payload['store']);self.assertTrue(payload['stream']);self.assertEqual(set(payload),{'model','input','store','stream'});self.assertEqual(send.call_args.args[0],'https://api.openai.com/v1/responses')
    def test_interrupted_stream_is_not_success(self):
        with patch('worker.inference.oauth.models',return_value=[('gpt-6-luna','Luna')]),patch('worker.inference.oauth.access_token',return_value='unit-test-oauth'),patch('worker.inference.requests.post',return_value=self.wire([])):
            with self.assertRaises(RuntimeError):Inference('gpt-6-luna').run('test')
    def test_streamed_limit_code_survives(self):
        events=[{'type':'response.failed','response':{'error':{'code':'subscription_sharing_usage_limit_exceeded'}}}]
        with patch('worker.inference.oauth.models',return_value=[('gpt-6-luna','Luna')]),patch('worker.inference.oauth.access_token',return_value='unit-test-oauth'),patch('worker.inference.requests.post',return_value=self.wire(events)):
            with self.assertRaises(PlanError) as context:Inference('gpt-6-luna').run('test')
        self.assertEqual(context.exception.code,'subscription_sharing_usage_limit_exceeded')
    def test_top_level_error_code_survives(self):
        from worker.inference import error_from
        error=error_from({'type':'error','code':'subscription_sharing_usage_limit_exceeded'})
        self.assertEqual(error.code,'subscription_sharing_usage_limit_exceeded')

class Review(unittest.TestCase):
    def test_unsupported_web_tool_falls_back_once_to_collected_publications(self):
        now=datetime.now(timezone.utc).isoformat();url='https://www.bbc.com/news/article'
        candidate={'id':'a','url':url,'title':'Test source','publishedAt':now,'excerpt':'Public test text'}
        output={'text':json.dumps({'items':[{'title':'Проверка','summary':'Кратко','importance':'Значимость','eventDate':None,'source_ids':['a'],'urls':[]}]}),'citations':[],'model':'gpt-6-luna'}
        model=MagicMock();model.run.side_effect=[PlanError('subscription_sharing_unsupported_capability',400,param='tools[0]'),output]
        with patch('worker.news.store.load',return_value={}),patch('worker.news.store.save'),patch('worker.news.sources.collect',return_value=[candidate]),patch('worker.news.sources.verify',return_value=candidate):
            answer=News(model).generate('ai')
        self.assertEqual(answer['mode'],'news');self.assertEqual(model.run.call_count,2);self.assertFalse(model.run.call_args.kwargs['search'])
    def test_cache_never_calls_model(self):
        key=cache_key('ai','');cached={'savedAt':1000,'answer':{'mode':'news','items':[{'title':'cached'}]}}
        inference=MagicMock()
        with patch('worker.news.store.load',return_value={key:cached}):result=News(inference,clock=lambda:1100).generate('ai')
        self.assertTrue(result['cacheHit']);inference.run.assert_not_called()
    def test_invalid_category_stops_before_collection(self):
        with self.assertRaises(RuntimeError):News(MagicMock()).generate('shell')
    def test_unknown_source_cannot_be_published(self):
        model=MagicMock();model.run.return_value={'text':json.dumps({'items':[{'title':'test','summary':'test','importance':'test','eventDate':None,'source_ids':[],'urls':['https://www.bbc.com/news/not-cited']}]}),'citations':[],'model':'gpt-6-luna'}
        with patch('worker.news.store.load',return_value={}),patch('worker.news.store.save'),patch('worker.news.sources.collect',return_value=[]):
            with self.assertRaises(RuntimeError):News(model).generate('politics')
    def test_yesterday_event_is_not_published(self):
        model=MagicMock();model.run.return_value={'text':json.dumps({'items':[{'title':'old','summary':'old','importance':'old','eventDate':'2000-01-01','source_ids':['a'],'urls':[]}]}),'citations':[],'model':'gpt-6-luna'}
        with patch('worker.news.store.load',return_value={}),patch('worker.news.store.save'),patch('worker.news.sources.collect',return_value=[{'id':'a','url':'https://bbc.com/news/a'}]):
            with self.assertRaises(RuntimeError):News(model).generate('politics')
    def test_daily_limit_stops_before_model(self):
        day=datetime.now(sources.TZ).date().isoformat();model=MagicMock()
        with patch('worker.news.store.load',side_effect=[{}, {'day':day,'calls':12}]):
            with self.assertRaises(RuntimeError):News(model).generate('ai',daily_limit=12)
        model.run.assert_not_called()

if __name__=='__main__':unittest.main()
