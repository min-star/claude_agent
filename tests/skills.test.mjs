import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createSkillRegistry, parseSkill, skillSystemMessage } from '../server/skills.mjs'
import { createApp } from '../server/app.mjs'
import { readSSE } from '../shared/sse.js'

const encoder=new TextEncoder()
function response(events){return new Response(new ReadableStream({start(c){for(const data of events)c.enqueue(encoder.encode(`data: ${typeof data==='string'?data:JSON.stringify(data)}\n\n`));c.close()}}),{headers:{'content-type':'text/event-stream'}})}
async function fixture(run){
 const root=await mkdtemp(path.join(tmpdir(),'chat-skills-'))
 await mkdir(path.join(root,'demo/references'),{recursive:true})
 await writeFile(path.join(root,'demo/SKILL.md'),'---\nname: test-skill\ndescription: >\n  测试多行\n  技能描述\nargument-hint: "[主题]"\nallowed-tools: [Read, Bash]\n---\n# 技能\n按中文回答。任务：$ARGUMENTS\n参考 [说明](references/guide.md)。')
 await writeFile(path.join(root,'demo/references/guide.md'),'正确参考值：青竹731')
 const sources=[{path:root,label:'测试'}]
 try{await run({root,sources,registry:createSkillRegistry(sources)})}finally{await rm(root,{recursive:true,force:true})}
}
async function serve(sources,fetchImpl,run){const app=createApp({initialConfig:{apiKey:'test-secret',baseUrl:'https://example.com/v1',model:'deepseek-flash'},skillSources:sources,fetchImpl});await new Promise(r=>app.listen(0,'127.0.0.1',r));try{await run(`http://127.0.0.1:${app.address().port}`)}finally{app.closeAllConnections();await new Promise(r=>app.close(r))}}
const post=(base,body)=>fetch(base+'/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})

test('skill metadata handles YAML multiline values, user visibility, and unsupported requirements',()=>{
 const parsed=parseSkill('---\nname: editor\ndescription: |\n  编辑中文\n  保留原意\nuser-invocable: false\ncontext: fork\nhooks: {}\nallowed-tools:\n  - Read\n  - Bash(git:*)\n---\n正文','fallback')
 assert.equal(parsed.name,'editor');assert.equal(parsed.userInvocable,false);assert(parsed.description.includes('保留原意'));assert(parsed.requirements.includes('Bash(git:*)'));assert(parsed.requirements.includes('独立子任务'))
 assert.equal(parseSkill('# 标题\n普通技能','fallback').name,'fallback')
 assert.throws(()=>parseSkill('---\nname: first\nname: duplicate\n---\n正文','x'))
 assert.throws(()=>parseSkill('---\nname: x','x'))
})
test('catalog deduplicates symlinks, skips non-invocable/broken skills, and refreshes disk changes',()=>fixture(async({root,registry})=>{
 await symlink(path.join(root,'demo'),path.join(root,'alias'))
 await mkdir(path.join(root,'hidden'));await writeFile(path.join(root,'hidden/SKILL.md'),'---\nuser-invocable: false\n---\n隐藏技能')
 await mkdir(path.join(root,'broken'));await writeFile(path.join(root,'broken/SKILL.md'),'---\nname: [\n---\n坏技能')
 const list=await registry.list();assert.equal(list.skills.length,1);assert.equal(list.warnings.length,1);assert(!('content' in list.skills[0]));assert.equal(list.skills[0].description,'测试多行 技能描述')
 const id=list.skills[0].id
 await writeFile(path.join(root,'demo/SKILL.md'),'---\nname: test-skill\n---\n更新后的技能')
 assert.equal((await registry.get(id)).content,'更新后的技能')
 await mkdir(path.join(root,'added'));await writeFile(path.join(root,'added/SKILL.md'),'新技能')
 assert.equal((await registry.list(true)).skills.length,2)
}))
test('resource reads stay in selected skill and reject traversal, hidden files, symlink escape, and binary data',()=>fixture(async({root,registry})=>{
 const skill=await registry.get((await registry.list()).skills[0].id)
 assert((await registry.readResource(skill,'references/guide.md')).content.includes('青竹731'))
 assert((await registry.readResource(skill,'./references/guide.md')).content.includes('青竹731'))
 await writeFile(path.join(root,'outside.md'),'secret')
 await symlink(path.join(root,'outside.md'),path.join(root,'demo/references/escape.md'))
 await writeFile(path.join(root,'demo/references/binary.txt'),Buffer.from([0,1,2]))
 for(const name of ['../outside.md','/etc/passwd','.env','references/.hidden.md','references/escape.md','references/binary.txt','references/missing.md'])await assert.rejects(()=>registry.readResource(skill,name))
}))
test('skill injection expands arguments literally without executing dynamic shell instructions',()=>fixture(async({registry})=>{
 const skill=await registry.get((await registry.list()).skills[0].id)
 const message=skillSystemMessage(skill,'保留 $& 与 $1 原文')
 assert(message.content.includes('任务：保留 $& 与 $1 原文'));assert(!message.content.includes('$ARGUMENTS'));assert(message.content.includes('不支持终端执行'))
}))
test('API lists and previews skill, rejects forged IDs, and sends server-loaded instructions to model',()=>fixture(async({sources})=>{
 let called=0
 await serve(sources,async(_,options)=>{called++;const body=JSON.parse(options.body);assert(body.messages[1].content.includes('任务：测试主题'));assert.equal(body.tools[0].function.name,'read_skill_file');return response([{choices:[{delta:{content:'技能已加载'},finish_reason:'stop'}]},'[DONE]'])},async base=>{
  const list=await(await fetch(base+'/api/skills')).json();const id=list.skills[0].id
  const detail=await(await fetch(base+'/api/skills/'+id)).json();assert(detail.content.includes('参考'))
  const bad=await post(base,{skillId:'../../.env',messages:[{role:'user',content:'测试'}]});assert.equal(bad.status,404);assert.equal(called,0)
  const res=await post(base,{skillId:id,messages:[{role:'system',content:'宿主规则'},{role:'user',content:'测试主题'}]});const text=await res.text();assert(text.includes('技能已加载'));assert(text.includes('"skill"'));assert.equal(called,1)
 })
}))
test('tool round trip merges fragmented arguments, preserves reasoning, and aggregates usage',()=>fixture(async({sources})=>{
 let round=0
 await serve(sources,async(_,options)=>{
  const body=JSON.parse(options.body);round++
  if(round===1)return response([
   {choices:[{delta:{reasoning_content:'需要读取真实参考。',tool_calls:[{index:0,id:'call_1',type:'function',function:{name:'read_skill_file',arguments:'{"path":"references/'}}]}}]},
   {choices:[{delta:{tool_calls:[{index:0,function:{arguments:'guide.md"}'}}]},finish_reason:'tool_calls'}]},
   {choices:[],usage:{prompt_tokens:100,completion_tokens:10,total_tokens:110}},'[DONE]'])
  assert.equal(body.messages.at(-2).reasoning_content,'需要读取真实参考。')
  assert.equal(body.messages.at(-2).tool_calls[0].function.arguments,'{"path":"references/guide.md"}')
  assert.equal(body.messages.at(-1).role,'tool');assert(body.messages.at(-1).content.includes('青竹731'))
  return response([{choices:[{delta:{content:'参考值是青竹731'},finish_reason:'stop'}]},{choices:[],usage:{prompt_tokens:120,completion_tokens:10,total_tokens:130}},'[DONE]'])
 },async base=>{
  const id=(await(await fetch(base+'/api/skills')).json()).skills[0].id
  const res=await post(base,{skillId:id,thinking:true,messages:[{role:'user',content:'读取参考'}]});const events=[];for await(const event of readSSE(res.body))events.push(event)
  assert.equal(round,2);assert.equal(events.filter(e=>e==='[DONE]').length,1);assert(events.some(e=>e.includes('"status":"read"')));assert(events.some(e=>e.includes('"total_tokens":240')));assert(events.some(e=>e.includes('参考值是青竹731')))
 })
}))
test('invalid tool arguments return a real failure receipt without reading outside skill',()=>fixture(async({sources})=>{
 let round=0
 await serve(sources,async(_,options)=>{
  round++;const body=JSON.parse(options.body)
  if(round===1)return response([{choices:[{delta:{tool_calls:[{index:0,id:'bad',function:{name:'read_skill_file',arguments:'{"path":"../private.md"}'}}]},finish_reason:'tool_calls'}]},'[DONE]'])
  assert(JSON.parse(body.messages.at(-1).content).error)
  return response([{choices:[{delta:{content:'无法读取该文件'},finish_reason:'stop'}]},'[DONE]'])
 },async base=>{
  const id=(await(await fetch(base+'/api/skills')).json()).skills[0].id
  const text=await(await post(base,{skillId:id,messages:[{role:'user',content:'读取参考'}]})).text();assert(text.includes('"status":"error"'));assert(text.includes('无法读取该文件'));assert(!text.includes('test-secret'))
 })
}))
test('tool calls with truncated completion are not executed and repeated loops are bounded',()=>fixture(async({sources})=>{
 let count=0
 await serve(sources,async()=>{count++;return response([{choices:[{delta:{tool_calls:[{index:0,id:'again'+count,function:{name:'read_skill_file',arguments:'{"path":"references/guide.md"}'}}]},finish_reason:'tool_calls'}]},'[DONE]'])},async base=>{
  const id=(await(await fetch(base+'/api/skills')).json()).skills[0].id
  const text=await(await post(base,{skillId:id,messages:[{role:'user',content:'继续读取'}]})).text();assert.equal(count,4);assert(text.includes('轮次上限'));assert(!text.includes('data: [DONE]'))
 })
 await serve(sources,async()=>response([{choices:[{delta:{tool_calls:[{index:0,id:'bad',function:{name:'read_skill_file',arguments:'{"path":"references/guide.md"}'}}]},finish_reason:'length'}]},'[DONE]']),async base=>{
  const id=(await(await fetch(base+'/api/skills')).json()).skills[0].id
  const text=await(await post(base,{skillId:id,messages:[{role:'user',content:'读取'}]})).text();assert(text.includes('未执行参考读取'));assert(!text.includes('"status":"read"'))
 })
}))
