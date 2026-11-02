import { mkdir,readFile,readdir,open,rename,unlink } from 'node:fs/promises'
import path from 'node:path'
import { createHash,randomUUID } from 'node:crypto'
import { validId,normalizeConversation } from '../shared/conversations.js'
import { chatErrorMessage } from '../shared/chat-errors.js'
const failure=(message,status=400)=>Object.assign(new Error(message),{status})
const terminal=status=>status!=='running'
export function createRunManager({directory,conversations,generate}){
 const entries=new Map();let creation=Promise.resolve()
 const filename=id=>{if(!validId(id))throw failure('无效的生成任务 ID');return path.join(directory,id+'.json')}
 const snapshot=entry=>structuredClone(entry.run)
 const notify=entry=>{const value=snapshot(entry);for(const listener of entry.listeners)try{listener(value)}catch{entry.listeners.delete(listener)}}
 function stamp(entry){const r=entry.run;r.sequence++;r.updated=Date.now();Object.assign(r.message,{runId:r.id,runStatus:r.status,runSequence:r.sequence,revision:entry.baseRevision+r.sequence})}
 function persist(entry){
  const run=snapshot(entry),record={run,metadata:entry.metadata,requestHash:entry.requestHash,baseRevision:entry.baseRevision}
  const save=entry.writes.catch(()=>{}).then(async()=>{
   await mkdir(directory,{recursive:true,mode:0o700});const temporary=path.join(directory,`.${run.id}.${randomUUID()}.tmp`)
   try{const handle=await open(temporary,'wx',0o600);try{await handle.writeFile(JSON.stringify(record));await handle.sync()}finally{await handle.close()}await rename(temporary,filename(run.id))}finally{await unlink(temporary).catch(()=>{})}
   try{await conversations.save(run.conversationId,{...entry.metadata,updated:run.updated,messages:[run.message]})}catch(error){if(error.status===409){entry.controller.abort();return}throw error}
   entry.savedAt=Date.now()
  });entry.writes=save;return save
 }
 function changed(entry){
  stamp(entry)
  if(!entry.timer)entry.timer=setTimeout(()=>{entry.timer=null;notify(entry);if(Date.now()-entry.savedAt>=500)void persist(entry).catch(()=>{entry.storageFailed=true;entry.controller.abort()})},100)
 }
 async function finish(entry,status,error){
  if(entry.timer){clearTimeout(entry.timer);entry.timer=null}
  entry.run.status=status
  if(error)entry.run.message.error=chatErrorMessage(error,Boolean(entry.run.message.content))
  if(status==='cancelled')entry.run.message.interrupted=true
  stamp(entry)
  try{await persist(entry)}catch{entry.run.status='failed';entry.run.message.runStatus='failed';entry.run.message.error='生成记录保存失败，请立即导出对话备份。'}
  notify(entry)
 }
 async function pump(entry,request){
  const before=entry.run.message.content.length;let done=false
  try{
   for await(const data of generate(request,entry.controller.signal)){
    entry.controller.signal.throwIfAborted()
    if(typeof data==='symbol')continue
    if(data==='[DONE]'){done=true;break}
    if(data.error)throw failure(data.error.message||'模型响应失败')
    const delta=data.choices?.[0]?.delta,m=entry.run.message
    if(data.skill)m.skill=data.skill
    if(data.skill_file)(m.resources||=[]).push(data.skill_file)
    if(delta?.content)m.content+=delta.content
    if(delta?.reasoning_content)m.reasoning_content=(m.reasoning_content||'')+delta.reasoning_content
    if(data.usage)m.usage={...data.usage,total_tokens:entry.initialUsage+(data.usage.total_tokens||0)}
    changed(entry)
    if(data.choices?.[0]?.finish_reason==='length')throw failure('已达到输出上限，回复可能不完整')
    if(data.choices?.[0]?.finish_reason==='content_filter')throw failure('回复被模型内容过滤中断')
   }
   if(!done)throw failure('连接提前中断，请手动重试')
   if(entry.run.message.content.length===before)throw failure('模型未返回正文，请重试或关闭深度思考')
   if(!terminal(entry.run.status))await finish(entry,'completed')
  }catch(error){if(!terminal(entry.run.status))await finish(entry,entry.controller.signal.aborted&&!entry.storageFailed?'cancelled':'failed',entry.controller.signal.aborted&&!entry.storageFailed?null:error)}
 }
 function makeEntry(record){return {...record,controller:new AbortController(),listeners:new Set(),writes:Promise.resolve(),timer:null,savedAt:0,initialUsage:record.run.message.usage?.total_tokens||0}}
 async function get(id){
  if(entries.has(id))return entries.get(id)
  let record;try{record=JSON.parse(await readFile(filename(id),'utf8'))}catch(error){if(error.code==='ENOENT')throw failure('生成任务不存在',404);throw error}
  const r=record?.run
  if(!r||r.id!==id||!validId(r.conversationId)||!validId(r.messageId)||r.message?.id!==r.messageId||r.message?.role!=='assistant'||typeof r.message?.content!=='string'||!['running','completed','failed','cancelled','interrupted'].includes(r.status)||!Number.isFinite(r.sequence)||!Number.isFinite(record.baseRevision)||typeof record.requestHash!=='string'||!normalizeConversation({...record.metadata,messages:[r.message]}))throw failure('生成任务记录异常，原文件已保留',500)
  const entry=makeEntry(record);entries.set(id,entry)
  // A process restart cannot reconnect an upstream HTTP request owned by the old process.
  if(!terminal(entry.run.status))await finish(entry,'interrupted','本机服务已重启，原生成已停止，可点击「继续生成」。')
  return entry
 }
 return {
  async recover(){let files;try{files=await readdir(directory)}catch(error){if(error.code==='ENOENT')return;throw error}for(const file of files)if(file.endsWith('.json')&&validId(file.slice(0,-5)))try{await get(file.slice(0,-5))}catch{console.warn('生成任务记录无法恢复，原文件已保留：'+file)}},
  create(input){
   const operation=creation.then(async()=>{
    const conversation=normalizeConversation(input.conversation)
    if(!validId(input.id)||!validId(input.messageId)||!conversation||conversation.id!==input.conversationId||!Array.isArray(input.request?.messages))throw failure('生成任务格式无效')
    const message=conversation.messages.find(m=>m.id===input.messageId&&m.role==='assistant')
    if(!message)throw failure('缺少生成目标消息')
    const requestHash=createHash('sha256').update(JSON.stringify(input)).digest('hex')
    let previous;try{previous=await get(input.id)}catch(error){if(error.status!==404)throw error}
    if(previous){if(previous.requestHash!==requestHash)throw failure('任务 ID 已被其他请求使用',409);return snapshot(previous)}
    if([...entries.values()].some(e=>e.run.conversationId===conversation.id&&!terminal(e.run.status)))throw failure('当前对话已有生成任务，请等待完成或停止',409)
    const metadata={...conversation,messages:undefined},run={id:input.id,conversationId:conversation.id,messageId:message.id,sequence:0,status:'running',updated:Date.now(),message:{...message,error:undefined,interrupted:undefined}}
    const entry=makeEntry({run,metadata,requestHash,baseRevision:message.revision||0})
    await conversations.save(conversation.id,conversation);entries.set(run.id,entry);stamp(entry)
    try{await persist(entry)}catch(error){entries.delete(run.id);throw error}
    entry.task=pump(entry,input.request);return snapshot(entry)
   });creation=operation.catch(()=>{});return operation
  },
  async get(id){const entry=await get(id);if(terminal(entry.run.status))await entry.writes;return snapshot(entry)},
  async subscribe(id,after,listener){const entry=await get(id);if(terminal(entry.run.status))await entry.writes;entry.listeners.add(listener);try{if(entry.run.sequence>after||terminal(entry.run.status))listener(snapshot(entry))}catch(error){entry.listeners.delete(listener);throw error}return()=>entry.listeners.delete(listener)},
  async cancel(id){const entry=await get(id);if(!terminal(entry.run.status)){entry.run.status='cancelled';entry.controller.abort();await finish(entry,'cancelled')}return snapshot(entry)},
  async shutdown(){await Promise.all([...entries.values()].filter(e=>!terminal(e.run.status)).map(async entry=>{entry.run.status='interrupted';entry.controller.abort();await finish(entry,'interrupted','本机服务已重启，原生成已停止，可点击「继续生成」。')}))},
 }
}
