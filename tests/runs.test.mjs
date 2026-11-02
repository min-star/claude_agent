import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,rm,readFile,writeFile,mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/app.mjs'
import { readSSE } from '../shared/sse.js'
import { createRunManager } from '../server/runs.mjs'
const encode=new TextEncoder()
const event=content=>encode.encode('data: '+JSON.stringify({choices:[{delta:{content}}]})+'\n\n')
const input={id:'refresh-run',conversationId:'refresh-chat',messageId:'answer',conversation:{id:'refresh-chat',title:'刷新测试',updated:1,messages:[{id:'question',role:'user',content:'请写长回答'},{id:'answer',role:'assistant',content:''}]},request:{messages:[{role:'user',content:'请写长回答'}]}}
async function fixture(run){const directory=await mkdtemp(path.join(tmpdir(),'generation-runs-'));let controller,calls=0,aborted=false
 const options={conversationDirectory:path.join(directory,'conversations'),runDirectory:path.join(directory,'runs'),skillSources:[],initialConfig:{baseUrl:'https://example.com/v1',apiKey:'test-key',model:'deepseek-flash'},fetchImpl:async(_,options)=>{calls++;options.signal.addEventListener('abort',()=>{aborted=true;controller?.error(new Error('cancelled'))});return new Response(new ReadableStream({start(c){controller=c;c.enqueue(event('前半段。'))}}),{headers:{'content-type':'text/event-stream'}})}}
 const app=createApp(options);await new Promise(r=>app.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.address().port}`
 try{await run({base,app,options,get calls(){return calls},get aborted(){return aborted},finish(){controller.enqueue(event('后半段。'));controller.enqueue(encode.encode('data: [DONE]\n\n'));controller.close()}})}finally{await app.shutdownRuns();app.closeAllConnections();await new Promise(r=>app.close(r));await rm(directory,{recursive:true,force:true})}}
const start=base=>fetch(base+'/api/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)})
test('refresh detaches the subscriber without cancelling generation, then reattaches without a second model request',()=>fixture(async f=>{
 const response=await start(f.base);assert.equal(response.status,202,'generation must have a server-owned run before streaming')
 const first=await fetch(f.base+'/api/runs/refresh-run/events');const iterator=readSSE(first.body)
 let snapshot
 for await(const raw of iterator){snapshot=JSON.parse(raw).run;if(snapshot.message.content==='前半段。')break}
 assert.equal(f.aborted,false,'refresh cancelled the upstream model request')
 const duplicate=await start(f.base);assert.equal(duplicate.status,202);assert.equal(f.calls,1,'reconnecting created a second paid request')
 f.finish()
 const resumed=await fetch(f.base+`/api/runs/refresh-run/events?after=${snapshot.sequence}`)
 for await(const raw of readSSE(resumed.body))snapshot=JSON.parse(raw).run
 assert.equal(snapshot.status,'completed');assert.equal(snapshot.message.content,'前半段。后半段。');assert.equal(f.calls,1)
 const history=await(await fetch(f.base+'/api/conversations')).json();assert.equal(history.conversations[0].messages.at(-1).content,'前半段。后半段。',JSON.stringify(history))
}))
test('only explicit cancellation stops a run; duplicate starts and conflicting requests are bounded',()=>fixture(async f=>{
 assert.equal((await start(f.base)).status,202)
 const cancel=await(await fetch(f.base+'/api/runs/refresh-run/cancel',{method:'POST'})).json()
 assert.equal(cancel.status,'cancelled');assert.equal(f.aborted,true)
 assert.equal((await start(f.base)).status,202);assert.equal(f.calls,1)
 const conflict=await fetch(f.base+'/api/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...input,request:{messages:[{role:'user',content:'另一个请求'}]}})})
 assert.equal(conflict.status,409);assert.equal(f.calls,1)
}))
test('a hard server restart keeps partial text, marks the old job interrupted, and never reissues it',()=>fixture(async f=>{
 await start(f.base);f.finish()
 for await(const _ of readSSE((await fetch(f.base+'/api/runs/refresh-run/events')).body)){}
 const file=path.join(f.options.runDirectory,'refresh-run.json'),record=JSON.parse(await readFile(file,'utf8'))
 record.run.status='running';record.run.message.runStatus='running';await writeFile(file,JSON.stringify(record))
 const restarted=createApp({...f.options,recoverRuns:true});await new Promise(r=>restarted.listen(0,'127.0.0.1',r))
 try{const result=await(await fetch(`http://127.0.0.1:${restarted.address().port}/api/runs/refresh-run`)).json();assert.equal(result.status,'interrupted');assert.equal(result.message.content,'前半段。后半段。');assert(result.message.error.includes('重启'));assert.equal(f.calls,1)}finally{restarted.closeAllConnections();await new Promise(r=>restarted.close(r))}
}))
test('subscriber failures never terminate the producer',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'run-subscriber-'));let release
 const gate=new Promise(resolve=>release=resolve)
 const manager=createRunManager({directory,conversations:{async save(){}},generate:async function*(){await gate;yield {choices:[{delta:{content:'完整内容'}}]};yield '[DONE]'}})
 try{await manager.create(input);await manager.subscribe(input.id,1,()=>{throw new Error('socket closed during refresh')});release();let result;for(let i=0;i<100;i++){result=await manager.get(input.id);if(result.status!=='running')break;await new Promise(r=>setTimeout(r,5))}assert.equal(result.status,'completed');assert.equal(result.message.content,'完整内容')}finally{await manager.shutdown();await rm(directory,{recursive:true,force:true})}
})
test('one corrupt run record does not block startup or overwrite its file',()=>fixture(async f=>{
 await mkdir(f.options.runDirectory,{recursive:true});const file=path.join(f.options.runDirectory,'broken-run.json');await writeFile(file,'{}')
 const app=createApp({...f.options,recoverRuns:true});await new Promise(r=>app.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.address().port}`
 try{assert.equal((await fetch(base+'/api/config')).status,200);assert.equal((await start(base)).status,202);f.finish();for await(const _ of readSSE((await fetch(base+'/api/runs/refresh-run/events')).body)){}assert.equal(await readFile(file,'utf8'),'{}')}finally{await app.shutdownRuns();app.closeAllConnections();await new Promise(r=>app.close(r))}
}))
