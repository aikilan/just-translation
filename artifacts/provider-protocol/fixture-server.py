from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import json
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def headers_for(self,kind):
  self.send_response(200); self.send_header('Content-Type',kind); self.send_header('Access-Control-Allow-Origin','*'); self.send_header('Access-Control-Allow-Headers','*'); self.end_headers()
 def do_OPTIONS(self): self.headers_for('text/plain')
 def do_GET(self):
  self.headers_for('text/html; charset=utf-8'); self.wfile.write(b'<html lang="en"><head><title>Translation protocol fixture</title></head><body><article><h1>Reading with a translation assistant</h1><p>This article explains how to read foreign language documents with a translation assistant. The original text stays on the page.</p><p>Each paragraph should receive its own translation, and the document should remain easy to read after the task finishes.</p></article></body></html>')
 def do_POST(self):
  body=json.loads(self.rfile.read(int(self.headers['content-length']))); content=body['messages'][-1]['content']; segments=json.loads(content)['segments']; text=json.dumps({'translations':[{'id':s['id'],'text':'翻译成功：'+s['text']} for s in segments]},ensure_ascii=False)
  with open('/tmp/jt-protocol-requests.jsonl','a') as f:f.write(json.dumps({'path':self.path,'body':body,'headers':dict(self.headers)})+'\n')
  if self.path.endswith('/messages'):
   events=[('message_start',{'message':{'role':'assistant','content':[]}}),('content_block_start',{'index':0,'content_block':{'type':'thinking','thinking':''}}),('content_block_delta',{'index':0,'delta':{'type':'thinking_delta','thinking':'private reasoning'}}),('content_block_stop',{'index':0}),('content_block_start',{'index':1,'content_block':{'type':'text','text':''}}),('content_block_delta',{'index':1,'delta':{'type':'text_delta','text':text}}),('content_block_stop',{'index':1}),('message_delta',{'delta':{'stop_reason':'end_turn'}}),('message_stop',{})]
   wire=''.join('event: '+kind+'\ndata: '+json.dumps({'type':kind,**value},ensure_ascii=False)+'\n\n' for kind,value in events)
  else:wire='data: '+json.dumps({'choices':[{'index':0,'delta':{'content':text},'finish_reason':None}]},ensure_ascii=False)+'\n\ndata: '+json.dumps({'choices':[{'index':0,'delta':{},'finish_reason':'stop'}]})+'\n\ndata: [DONE]\n\n'
  self.headers_for('text/event-stream');self.wfile.write(wire.encode())
ThreadingHTTPServer(('127.0.0.1',18767),Handler).serve_forever()
