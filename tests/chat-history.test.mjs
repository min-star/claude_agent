import test, { before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import React from 'react'
import { mergeConversation } from '../shared/conversations.js'
import { createRunManager } from '../server/runs.mjs'
import { readSSE } from '../shared/sse.js'

const key='deepseek-chat-conversations-v1'
let dom,App,render,fireEvent,waitFor,cleanup,act,within,temp
before(async()=>{
 dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://127.0.0.1:3210/chat'})
 for(const name of ['window','document','navigator','HTMLElement','Node','MutationObserver','localStorage'])Object.defineProperty(globalThis,name,{configurable:true,value:dom.window[name]})
 globalThis.innerWidth=1200;globalThis.IS_REACT_ACT_ENVIRONMENT=true
 dom.window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}})
 const testing=await import('@testing-library/react');({render,fireEvent,waitFor,cleanup,act,within}=testing)
 const original=await readFile('web/src/main.tsx','utf8')
 const source=original.replace(/createRoot\(document\.getElementById\('root'\)!\)\.render\([\s\S]*?\)\s*$/,'export { App }').replace("import Markdown from 'react-markdown'", "import ActualMarkdown from 'react-markdown'\nfunction Markdown(props){globalThis.markdownParses=(globalThis.markdownParses||0)+1;return React.createElement(ActualMarkdown,props)}")
 assert.notEqual(source,original,'test entry must expose the real App')
 const built=await build({stdin:{contents:source,resolveDir:path.resolve('web/src'),sourcefile:'main.tsx',loader:'tsx'},bundle:true,write:false,format:'esm',platform:'node',packages:'external',loader:{'.css':'empty'}})
 await mkdir('node_modules/.cache',{recursive:true});temp=await mkdtemp('node_modules/.cache/chat-history-')
 const entry=path.resolve(temp,'app.mjs');await writeFile(entry,built.outputFiles[0].text)
 ;({App}=await import(pathToFileURL(entry).href))
})
afterEach(async()=>{cleanup();await new Promise(r=>setTimeout(r,20));dom.window.localStorage.clear()})
after(async()=>{dom.window.close();if(temp)await rm(temp,{recursive:true,force:true})})
function seed(){
 const remote=new Map()
 const runs=createRunManager({directory:path.join(temp,crypto.randomUUID()),conversations:{async save(id,chat){const merged=mergeConversation(remote.get(id),chat);remote.set(id,merged);return {conversation:merged}}},generate:async function*(input,signal){const response=await globalThis.fetch('/api/chat',{method:'POST',body:JSON.stringify(input),signal});if(!response.ok){const data=await response.json();throw new Error(data.error)}for await(const raw of readSSE(response.body)){if(raw==='[DONE]'){yield raw;return}yield JSON.parse(raw)}}})

 localStorage.setItem(key,JSON.stringify([{id:'existing-chat',title:'原有对话',updated:1,messages:[{id:'old-user',role:'user',content:'原有问题'},{id:'old-answer',role:'assistant',content:'原有回答'}]}]))
 localStorage.setItem('deepseek-chat-active','existing-chat')
 globalThis.fetch=async (url,options={})=>{
  if(String(url)==='/api/runs')return Response.json(await runs.create(JSON.parse(options.body)),{status:202})
  const match=String(url).match(/^\/api\/runs\/([^/]+)\/(events|cancel)/)
  if(match){
   if(match[2]==='cancel')return Response.json(await runs.cancel(match[1]))
   try{await runs.get(match[1])}catch(error){return Response.json({error:error.message},{status:error.status||500})}
   let detach,closed=false
   return new Response(new ReadableStream({start(controller){const abort=()=>{if(!closed){closed=true;detach?.();controller.error(new Error('aborted'))}};options.signal?.addEventListener('abort',abort,{once:true});void runs.subscribe(match[1],Number(new URL(String(url),'http://localhost').searchParams.get('after'))||0,run=>{if(closed)return;controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({run})+'\n\n'));if(run.status!=='running'){closed=true;controller.close();detach?.();options.signal?.removeEventListener('abort',abort)}}).then(fn=>{detach=fn;if(closed)fn()})},cancel(){closed=true;detach?.()}}),{headers:{'content-type':'text/event-stream'}})
  }
  if(String(url).startsWith('/api/conversations?'))return Response.json({conversations:[...remote.values()],deletedIds:[],cursor:0})
  if(String(url).startsWith('/api/conversations/')&&options.method==='PUT'){const chat=JSON.parse(options.body);const merged=mergeConversation(remote.get(chat.id),chat);remote.set(chat.id,merged);return Response.json({conversation:merged})}
  if(String(url).startsWith('/api/conversations/')&&options.method==='DELETE'){remote.delete(String(url).split('/').at(-1));return Response.json({deleted:true})}
  if(String(url)==='/api/config')return Response.json({configured:true,model:'deepseek-flash'})
  if(String(url).startsWith('/api/skills'))return Response.json({skills:[],sources:[],warnings:[]})
  if(String(url)==='/api/chat')return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"测试回复"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));controller.close()}}),{headers:{'content-type':'text/event-stream'}})
  throw new Error('Unexpected request: '+url)
 }
}
async function mount(){const container=document.createElement('div');document.body.append(container);render(React.createElement(React.StrictMode,null,React.createElement(App)),{container,baseElement:container});const ui=within(container);await waitFor(()=>assert(ui.getByText('模型已配置')));return ui}
async function send(ui,text){fireEvent.change(ui.getByRole('textbox',{name:'发送消息'}),{target:{value:text}});fireEvent.click(ui.getByRole('button',{name:'发送',exact:true}));await waitFor(()=>assert(ui.getByRole('button',{name:'发送',exact:true}).disabled))}

function savedText(){return Array.from({length:localStorage.length},(_,i)=>localStorage.getItem(localStorage.key(i))).join('\n')}

test('a stale chat window cannot erase a conversation created in another window',async()=>{
 seed()
 const stale=await mount(),writer=await mount()
 fireEvent.click(writer.getByRole('button',{name:/^新对话/}))
 await send(writer,'新窗口的重要对话')
 await waitFor(()=>assert(savedText().includes('新窗口的重要对话'),'new conversation should initially persist'))
 await send(stale,'旧窗口继续提问')
 assert(savedText().includes('新窗口的重要对话'),'chat history disappeared after the stale window saved its snapshot')
})

test('a failed regeneration keeps the previous answer visible',async()=>{
 seed()
 const originalFetch=globalThis.fetch
 globalThis.fetch=(url,...args)=>String(url)==='/api/chat'?Promise.resolve(Response.json({error:'测试网关暂不可用'},{status:502})):originalFetch(url,...args)
 const ui=await mount()
 fireEvent.click(ui.getByRole('button',{name:/重新生成/}))
 await waitFor(()=>assert(ui.getByRole('alert').textContent.includes('测试网关暂不可用')))
 assert(ui.queryByText('原有回答'),'the original answer disappeared when regeneration failed')
})

test('one damaged record cannot erase other valid conversations on load',async()=>{
 seed()
 const data=JSON.parse(localStorage.getItem(key));localStorage.setItem(key,JSON.stringify([null,...data]))
 const ui=await mount()
 assert(ui.queryByText('原有回答'),'valid chat history disappeared because another record was malformed')
})

test('server backup restores a chat even when browser storage cannot save it',async()=>{
 seed()
 const ui=await mount()
 const prototype=Object.getPrototypeOf(localStorage),originalSet=prototype.setItem
 prototype.setItem=function(){throw new dom.window.DOMException('storage full','QuotaExceededError')}
 try{
  fireEvent.click(ui.getByRole('button',{name:/^新对话/}));await send(ui,'浏览器满了仍需保存的重要内容')
  await waitFor(()=>assert(ui.getByRole('status').textContent.includes('已保存到本机服务')),{timeout:2000})
  cleanup();await new Promise(r=>setTimeout(r,20));localStorage.clear()
  const restored=await mount()
  await waitFor(()=>assert(restored.queryAllByText('浏览器满了仍需保存的重要内容').length>0))
  await waitFor(()=>assert(restored.queryByText('测试回复'),'server recovery restored the sidebar but failed to select the recovered chat'))
 }finally{prototype.setItem=originalSet}
})

test('receiving another window history update never clears the active response',async()=>{
 seed();const ui=await mount()
 localStorage.setItem('deepseek-chat-conversation-v2:external',JSON.stringify({id:'external',title:'其他页面新对话',updated:Date.now(),messages:[{id:'external-user',role:'user',content:'其他页面的问题'}]}))
 await act(async()=>window.dispatchEvent(new window.StorageEvent('storage',{key:'deepseek-chat-conversation-v2:external'})))
 assert(ui.queryByText('原有回答'));assert(ui.queryByRole('button',{name:'其他页面新对话',exact:true}))
})

test('a disconnected stream retains partial output across reload',async()=>{
 seed();const originalFetch=globalThis.fetch
 globalThis.fetch=(url,...args)=>String(url)==='/api/chat'?Promise.resolve(new Response('data: {"choices":[{"delta":{"content":"已经收到的长回复片段"}}]}\n\n',{headers:{'content-type':'text/event-stream'}})):originalFetch(url,...args)
 const ui=await mount();await send(ui,'网络中断测试')
 await waitFor(()=>assert(ui.getByRole('alert').textContent.includes('连接中断')))
 assert(ui.queryByText('已经收到的长回复片段'))
 await waitFor(()=>assert(ui.getByRole('status').textContent.includes('已保存到本机服务')),{timeout:2000})
 cleanup();await new Promise(r=>setTimeout(r,20));const restored=await mount()
 assert(restored.queryByText('已经收到的长回复片段'))
})

test('typing does not reparse completed long answers',async()=>{
 seed();const records=JSON.parse(localStorage.getItem(key));records[0].messages[1].content='# 长回复\n\n'+('| 项目 | 数值 |\n| --- | --- |\n| 测试 | 123 |\n\n'.repeat(100));localStorage.setItem(key,JSON.stringify(records))
 const ui=await mount();globalThis.markdownParses=0
 for(let i=1;i<=6;i++)fireEvent.change(ui.getByRole('textbox',{name:'发送消息'}),{target:{value:'继续'.repeat(i)}})
 assert.equal(globalThis.markdownParses,0,'typing reparsed all completed Markdown answers and blocked the UI')
})

test('a burst of streaming tokens is rendered in batches without losing output',async()=>{
 seed();const originalFetch=globalThis.fetch,piece='这是长回复中的一个段落。\n\n',count=300
 globalThis.fetch=(url,...args)=>String(url)==='/api/chat'?Promise.resolve(new Response(new ReadableStream({start(controller){for(let i=0;i<count;i++)controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{content:piece}}]})+'\n\n'));controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));controller.close()}}),{headers:{'content-type':'text/event-stream'}})):originalFetch(url,...args)
 const ui=await mount();globalThis.markdownParses=0
 await send(ui,'流式长回答性能测试')
 await waitFor(()=>assert.equal(ui.getAllByRole('article').at(-1).querySelector('.message-content').textContent.replace(/\s/g,''),piece.repeat(count).replace(/\s/g,'')))
 assert(globalThis.markdownParses<30,`300 token events caused ${globalThis.markdownParses} Markdown parses instead of batched rendering`)
})

test('a network failure keeps its partial answer and can continue after reload',async()=>{
 seed();const originalFetch=globalThis.fetch;let calls=0
 globalThis.fetch=(url,options)=>{
  if(String(url)!=='/api/chat')return originalFetch(url,options)
  calls++
  const request=JSON.parse(options.body)
  if(calls===2){assert.equal(request.messages.at(-2).content,'长回答已收到的前半段。');assert(request.messages.at(-1).content.includes('继续'))}
  const events=calls===1?[{choices:[{delta:{content:'长回答已收到的前半段。'}}]},{error:{message:'network error'}}]:[{choices:[{delta:{content:'接上后半段，回答完成。'}}]}]
  return Promise.resolve(new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')+(calls===2?'data: [DONE]\n\n':''),{headers:{'content-type':'text/event-stream'}}))
 }
 const ui=await mount();await send(ui,'断网续写测试')
 await waitFor(()=>assert(ui.getByRole('alert').textContent.includes('连接中断')))
 await waitFor(()=>assert(ui.getByRole('status').textContent.includes('已保存到本机服务')),{timeout:2000})
 cleanup();await new Promise(r=>setTimeout(r,20));const restored=await mount()
 assert(restored.queryByText('长回答已收到的前半段。'))
 fireEvent.click(restored.getByRole('button',{name:'继续生成',exact:true}))
 await waitFor(()=>assert(restored.queryByText('长回答已收到的前半段。接上后半段，回答完成。')))
 assert.equal(restored.queryByRole('alert'),null,'old network error survived a successful continuation')
 await waitFor(()=>assert(restored.getByRole('status').textContent.includes('已保存到本机服务')),{timeout:2000})
 cleanup();await new Promise(r=>setTimeout(r,20));const completed=await mount()
 assert(completed.queryByText('长回答已收到的前半段。接上后半段，回答完成。'));assert.equal(completed.queryByRole('alert'),null)
})

test('refreshing during generation automatically restores the same server task',async()=>{
 seed();const originalFetch=globalThis.fetch;let controller,calls=0,aborted=false
 globalThis.fetch=(url,options)=>{
  if(String(url)!=='/api/chat')return originalFetch(url,options)
  calls++;options.signal.addEventListener('abort',()=>{aborted=true})
  return Promise.resolve(new Response(new ReadableStream({start(c){controller=c;c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"刷新前的正文。"}}]}\n\n'))}}),{headers:{'content-type':'text/event-stream'}}))
 }
 const ui=await mount();fireEvent.change(ui.getByRole('textbox',{name:'发送消息'}),{target:{value:'生成期间刷新验证'}});fireEvent.click(ui.getByRole('button',{name:'发送',exact:true}))
 await waitFor(()=>assert(ui.queryByText('刷新前的正文。')))
 cleanup();await new Promise(r=>setTimeout(r,20));assert.equal(aborted,false,'unmount aborted the model request')
 controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"刷新后后台继续完成。"}}]}\n\ndata: [DONE]\n\n'));controller.close()
 const restored=await mount()
 await waitFor(()=>assert(restored.queryByText('刷新前的正文。刷新后后台继续完成。')))
 assert.equal(restored.queryByRole('alert'),null);assert.equal(restored.queryByRole('button',{name:'停止生成'}),null);assert.equal(calls,1)
})
