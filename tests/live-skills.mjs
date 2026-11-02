import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createApp } from '../server/app.mjs'
import { readSSE } from '../shared/sse.js'

const root=await mkdtemp(path.join(tmpdir(),'deepseek-live-skill-'))
const proof='SKILL-'+randomUUID().slice(0,8)
await mkdir(path.join(root,'verification/references'),{recursive:true})
await writeFile(path.join(root,'verification/SKILL.md'),'---\nname: skill-verification\ndescription: 验证技能指引及参考读取。\n---\n当用户询问验证代码时，必须调用 read_skill_file 读取 references/proof.md，然后只输出文件中的验证代码。不要编造代码。')
await writeFile(path.join(root,'verification/references/proof.md'),`验证代码：${proof}`)
const app=createApp({skillSources:[{path:root,label:'临时验证'}]})
await new Promise(r=>app.listen(0,'127.0.0.1',r))
const base=`http://127.0.0.1:${app.address().port}`
try{
 const config=await(await fetch(base+'/api/config')).json();assert(config.configured,'请先配置网关 API Key')
 const catalog=await(await fetch(base+'/api/skills')).json();const skill=catalog.skills[0];assert(skill)
 for(const thinking of [false,true]){
  const start=Date.now()
  const res=await fetch(base+'/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({skillId:skill.id,thinking,messages:[{role:'user',content:'请按技能流程告诉我验证代码。'}]}),signal:AbortSignal.timeout(180000)})
  assert(res.ok,`HTTP ${res.status}: ${res.ok?'':await res.text()}`)
  let content='',done=false,loaded=false,read=false,usage=null,reasoning=0
  for await(const event of readSSE(res.body)){
   if(event==='[DONE]'){done=true;break}
   const data=JSON.parse(event);if(data.error)throw new Error(data.error.message)
   if(data.skill?.id===skill.id)loaded=true
   if(data.skill_file?.path==='references/proof.md'&&data.skill_file.status==='read')read=true
   content+=data.choices?.[0]?.delta?.content||'';reasoning+=(data.choices?.[0]?.delta?.reasoning_content||'').length
   if(data.usage)usage=data.usage
  }
  assert(loaded,'缺少技能加载确认');assert(read,'模型没有真实调用技能参考工具');assert(content.includes(proof),'返回的参考代码不正确');assert(done,'缺少结束标记');assert(usage?.total_tokens>0,'缺少用量')
  console.log(JSON.stringify({thinking,skill:skill.name,resourceRead:read,content,reasoningCharacters:reasoning,usage,durationMs:Date.now()-start}))
 }
 console.log('PASS: 技能从磁盘加载、真实 DeepSeek 工具调用、参考内容回传、普通/思考模式、用量与结束标记。')
}finally{app.closeAllConnections();await new Promise(r=>app.close(r));await rm(root,{recursive:true,force:true})}
