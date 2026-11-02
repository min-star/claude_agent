import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp, normalizeBaseURL } from '../server/app.mjs'
import { readSSE } from '../shared/sse.js'
const key = 'test-key-not-real'
const encoder = new TextEncoder()
function stream(text,split=7){const bytes=encoder.encode(text);return new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=split)c.enqueue(bytes.slice(i,i+split));c.close()}})}
async function withApp(options,run){const app=createApp({initialConfig:{baseUrl:'https://example.com/v1',model:'deepseek-flash',apiKey:key,...options.config},fetchImpl:options.fetchImpl});await new Promise(r=>app.listen(0,'127.0.0.1',r));try{await run(`http://127.0.0.1:${app.address().port}`)}finally{app.closeAllConnections();await new Promise(r=>app.close(r))}}
const send=(base,data={messages:[{role:'user',content:'你好'}]},options={})=>fetch(`${base}/api/chat`,{method:'POST',headers:{'Content-Type':'application/json',...options.headers},body:JSON.stringify(data)})
const sse='data: {"choices":[{"delta":{"reasoning_content":"先思考"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"你好，世界"}}]}\r\n\r\ndata: {"choices":[],"usage":{"total_tokens":12}}\r\n\r\ndata: [DONE]\r\n\r\n'

test('SSE handles split UTF-8, CRLF, comments, and multiline events',async()=>{
 const events=[];for await(const event of readSSE(stream(': heartbeat\r\n\r\n'+sse,1)))events.push(event)
 assert.equal(events.length,4);assert.equal(JSON.parse(events[1]).choices[0].delta.content,'你好，世界');assert.equal(events[3],'[DONE]')
 const multi=[];for await(const event of readSSE(stream('data: one\ndata: two\n\n')))multi.push(event);assert.deepEqual(multi,['one\ntwo'])
})
test('public config never returns secrets; gateway changes require new credentials',async()=>withApp({},async base=>{
 const c=await(await fetch(base+'/api/config')).text();assert(!c.includes(key));assert(JSON.parse(c).configured)
 const res=await fetch(base+'/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({baseUrl:'https://another.example/v1'})});assert.equal(res.status,400)
}))
test('OpenAI request includes server credentials, reasoning history, and thinking switch',async()=>withApp({fetchImpl:async(url,options)=>{
 assert.equal(url,'https://example.com/v1/chat/completions');assert.equal(options.headers.Authorization,`Bearer ${key}`)
 const body=JSON.parse(options.body);assert.equal(body.model,'deepseek-flash');assert.equal(body.max_tokens,200000);assert.equal(body.stream,true);assert.deepEqual(body.thinking,{type:'enabled'});assert.equal(body.messages[1].reasoning_content,'真实推理');return new Response(stream(sse),{headers:{'Content-Type':'text/event-stream'}})
}},async base=>{
 const response=await send(base,{thinking:true,messages:[{role:'user',content:'你好'},{role:'assistant',content:'你好',reasoning_content:'真实推理'},{role:'user',content:'继续'}]});assert.equal(response.status,200);const text=await response.text();assert(text.includes('你好，世界'));assert(text.includes('先思考'));assert(text.includes('[DONE]'));assert(text.includes('total_tokens'));assert(!text.includes(key))
}))
test('rejects missing key and invalid messages before calling upstream',async()=>{
 await withApp({config:{apiKey:''},fetchImpl:()=>assert.fail('should not call upstream')},async base=>assert.equal((await send(base)).status,503))
 await withApp({fetchImpl:()=>assert.fail('should not call upstream')},async base=>{assert.equal((await send(base,{messages:[{role:'user',content:42}]})).status,400);assert.equal((await send(base,{messages:[{role:'tool',content:'x'}]})).status,400)})
})
test('upstream auth errors are actionable and secrets redacted',async()=>withApp({fetchImpl:async()=>new Response(JSON.stringify({error:{message:'Invalid token '+key}}),{status:401})},async base=>{const res=await send(base);assert.equal(res.status,401);const text=await res.text();assert(text.includes('API Key'));assert(!text.includes(key));assert(text.includes('[REDACTED]'))}))
test('premature stream and in-stream errors are not reported as successful completion',async()=>{
 for(const body of ['data: {"choices":[{"delta":{"content":"部分"}}]}\n\n','data: {"error":{"message":"quota exceeded"}}\n\n'])await withApp({fetchImpl:async()=>new Response(stream(body),{headers:{'Content-Type':'text/event-stream'}})},async base=>{const text=await(await send(base)).text();assert(text.includes('"error"'));assert(!text.includes('[DONE]'))})
})
test('client cancellation aborts upstream request',async()=>{
 let aborted;const abortedPromise=new Promise(r=>aborted=r)
 await withApp({fetchImpl:async(_,options)=>{options.signal.addEventListener('abort',aborted);return new Response(new ReadableStream({start(c){c.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"开始"}}]}\n\n'));options.signal.addEventListener('abort',()=>c.error(new Error('aborted')))}}),{headers:{'Content-Type':'text/event-stream'}})}},async base=>{
  const response=await send(base);const reader=response.body.getReader();await reader.read();await reader.cancel();await Promise.race([abortedPromise,new Promise((_,reject)=>setTimeout(()=>reject(new Error('upstream not aborted')),2000))])
 })
})
test('rejects cross-origin access and hides local files',async()=>withApp({},async base=>{assert.equal((await send(base,undefined,{headers:{Origin:'https://evil.example'}})).status,403);assert.equal((await fetch(base+'/.env')).status,404);assert.equal((await fetch(base+'/api/missing')).status,404)}))
test('normalizes URL without duplicate separators and rejects embedded credentials',()=>{assert.equal(normalizeBaseURL('https://example.com/v1/'),'https://example.com/v1');assert.throws(()=>normalizeBaseURL('https://key@example.com/v1'));assert.throws(()=>normalizeBaseURL('file:///etc/passwd'));assert.throws(()=>normalizeBaseURL('https://example.com/v1?key=secret'))})
