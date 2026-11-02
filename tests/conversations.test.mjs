import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createConversationRepository } from '../server/conversations.mjs'
import { mergeConversation, normalizeConversation, loadBrowserHistory, contextMessages } from '../shared/conversations.js'
import { createApp } from '../server/app.mjs'
const chat=(id='chat-one',text='完整回答',revision=1)=>({id,title:'测试会话',updated:1,messages:[{id:'question',role:'user',content:'原始问题'},{id:'answer',role:'assistant',content:text,revision}]})
async function fixture(run){const directory=await mkdtemp(path.join(tmpdir(),'chat-history-'));try{await run(directory)}finally{await rm(directory,{recursive:true,force:true})}}

test('server history survives restart and supports responses beyond localStorage-sized records',()=>fixture(async directory=>{
 const repository=createConversationRepository(directory)
 const long='完整剧本。'.repeat(600000)
 await repository.save('chat-one',chat('chat-one',long))
 const restored=await createConversationRepository(directory).list()
 assert.equal(restored.conversations[0].messages[1].content,long)
 assert(!(await readdir(directory)).some(name=>name.endsWith('.tmp')))
}))
test('stale concurrent snapshots cannot remove messages or truncate a streamed answer',()=>fixture(async directory=>{
 const repository=createConversationRepository(directory)
 await repository.save('chat-one',chat())
 const newer={...chat('chat-one','更长的完整回答与后续内容',8),messages:[...chat('chat-one','更长的完整回答与后续内容',8).messages,{id:'new-question',role:'user',content:'新问题'}]}
 await repository.save('chat-one',newer)
 await repository.save('chat-one',{...chat('chat-one','更长的完整回答与后续内容',2),messages:[...chat('chat-one','短',2).messages,{id:'another-question',role:'user',content:'另一页面的问题'}]})
 const restored=(await repository.list()).conversations[0]
 assert.equal(restored.messages.find(m=>m.id==='answer').content,'更长的完整回答与后续内容')
 assert(restored.messages.some(m=>m.id==='new-question'));assert(restored.messages.some(m=>m.id==='another-question'))
}))
test('per-chat concurrent writes preserve all conversations; cursor exposes only new changes',()=>fixture(async directory=>{
 const repository=createConversationRepository(directory)
 await Promise.all([repository.save('a',chat('a')),repository.save('b',chat('b'))])
 const first=await repository.list();assert.equal(first.conversations.length,2)
 assert.equal((await repository.list(first.cursor)).conversations.length,0)
 await repository.save('c',chat('c'))
 assert.deepEqual((await repository.list(first.cursor)).conversations.map(c=>c.id),['c'])
}))
test('deletion tombstones block stale tabs from resurrecting history',()=>fixture(async directory=>{
 const repository=createConversationRepository(directory)
 await repository.save('chat-one',chat());await repository.remove('chat-one')
 await assert.rejects(()=>repository.save('chat-one',chat()),e=>e.status===409)
 const result=await createConversationRepository(directory).list();assert.deepEqual(result.conversations,[]);assert(result.deletedIds.includes('chat-one'))
}))
test('clearing a selected skill survives persistence and older metadata',()=>fixture(async directory=>{
 const repository=createConversationRepository(directory)
 await repository.save('chat-one',{...chat(),skillId:'example',skillName:'技能'})
 await repository.save('chat-one',{...chat(),updated:2})
 await repository.save('chat-one',{...chat(),skillId:'example',skillName:'旧技能',updated:1})
 assert.equal((await repository.list()).conversations[0].skillId,undefined)
}))
test('successful continuation clears failure flags after restart and stale writes',()=>fixture(async directory=>{
 const repository=createConversationRepository(directory),partial=chat('chat-one','前半段',2)
 Object.assign(partial.messages[1],{error:'network error',interrupted:true})
 await repository.save('chat-one',partial)
 await repository.save('chat-one',chat('chat-one','前半段与完整后半段',3))
 await repository.save('chat-one',partial)
 const answer=(await createConversationRepository(directory).list()).conversations[0].messages[1]
 assert.equal(answer.content,'前半段与完整后半段');assert.equal(answer.error,undefined);assert.equal(answer.interrupted,undefined)
}))
test('corrupt server records are retained for recovery instead of overwritten',()=>fixture(async directory=>{
 await writeFile(path.join(directory,'chat-one.json'),'{malformed')
 await assert.rejects(()=>createConversationRepository(directory).save('chat-one',chat()))
 assert.equal(await readFile(path.join(directory,'chat-one.json'),'utf8'),'{malformed')
}))
test('browser migration salvages valid records and keeps raw legacy storage unchanged',()=>{
 const raw=JSON.stringify([null,chat(),{bad:true}]);const values=new Map([['deepseek-chat-conversations-v1',raw]])
 const storage={getItem:key=>values.get(key),key:index=>[...values.keys()][index],get length(){return values.size}}
 assert.equal(loadBrowserHistory(storage).chats.length,1);assert.equal(values.get('deepseek-chat-conversations-v1'),raw)
 assert.equal(normalizeConversation(null),null)
})
test('model context uses latest successful retry while all displayed answers remain available',()=>{
 const messages=[...chat().messages,{id:'retry-error',role:'assistant',content:'未完成',error:'超时'},{id:'retry-ok',role:'assistant',content:'新的完整回答'},{id:'next-question',role:'user',content:'继续'}]
 const context=contextMessages(messages)
 assert.equal(context.length,3);assert.equal(context[1].content,'新的完整回答');assert.equal(messages.length,5)
 const failed=contextMessages(messages.filter(m=>m.id!=='retry-ok'));assert.equal(failed[1].content,'完整回答')
})
test('conversation API persists individual chats and rejects cross-origin writes',()=>fixture(async directory=>{
 const app=createApp({conversationDirectory:directory,skillSources:[]});await new Promise(r=>app.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.address().port}`
 try{
  const save=await fetch(base+'/api/conversations/chat-one',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(chat())});assert.equal(save.status,200)
  const list=await(await fetch(base+'/api/conversations')).json();assert.equal(list.conversations[0].messages[1].content,'完整回答')
  const denied=await fetch(base+'/api/conversations/chat-one',{method:'DELETE',headers:{origin:'https://evil.example'}});assert.equal(denied.status,403)
 }finally{app.closeAllConnections();await new Promise(r=>app.close(r))}
}))
