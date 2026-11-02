export const HISTORY_KEY='deepseek-chat-conversations-v1'
export const RECORD_PREFIX='deepseek-chat-conversation-v2:'
export const DELETED_PREFIX='deepseek-chat-deleted-v2:'
export const validId=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,160}$/.test(value)
const number=value=>typeof value==='number'&&Number.isFinite(value)?value:0
export function normalizeConversation(value){
 if(!value||typeof value!=='object'||!validId(value.id)||typeof value.title!=='string'||!Array.isArray(value.messages))return null
 const messages=value.messages.filter(m=>m&&validId(m.id)&&['user','assistant'].includes(m.role)&&typeof m.content==='string').map(m=>({
  id:m.id,role:m.role,content:m.content,revision:Math.max(0,number(m.revision)),createdAt:number(m.createdAt),
  ...(validId(m.runId)?{runId:m.runId,runSequence:number(m.runSequence),runStatus:['running','completed','failed','cancelled','interrupted'].includes(m.runStatus)?m.runStatus:'interrupted'}:{}),
  ...Object.fromEntries(['reasoning_content','error','replyTo'].filter(field=>typeof m[field]==='string').map(field=>[field,m[field]])),
  ...(m.interrupted===true?{interrupted:true}:{}),
  ...(m.skill&&typeof m.skill.id==='string'&&typeof m.skill.name==='string'?{skill:{id:m.skill.id,name:m.skill.name}}:{}),
  ...(m.usage&&typeof m.usage.total_tokens==='number'?{usage:{total_tokens:number(m.usage.total_tokens)}}:{}),
  ...(Array.isArray(m.resources)?{resources:m.resources.filter(r=>r&&typeof r.path==='string'&&typeof r.status==='string').map(r=>({path:r.path,status:r.status,...(typeof r.error==='string'?{error:r.error}:{})}))}:{}),
 }))
 return {...value,title:value.title.slice(0,300),updated:number(value.updated),skillId:typeof value.skillId==='string'?value.skillId:undefined,skillName:typeof value.skillName==='string'?value.skillName:undefined,messages}
}
export function mergeConversation(current,incoming){
 if(!current)return incoming
 const next=number(incoming.updated)>=number(current.updated)?{...current,...incoming}:{...incoming,...current}
 const messages=new Map(current.messages.map(m=>[m.id,m]))
 for(const message of incoming.messages){
  const previous=messages.get(message.id)
  if(!previous){messages.set(message.id,message);continue}
  // A newer successful continuation can clear error/interrupted metadata.
  const newer=message.runId&&message.runId===previous.runId&&number(message.runSequence)!==number(previous.runSequence)?number(message.runSequence)>number(previous.runSequence):number(message.revision)>=number(previous.revision)
  const merged={...(newer?message:previous)}
  // An older tab or a partial snapshot must never truncate already received text.
  for(const field of ['content','reasoning_content']){const longest=(message[field]?.length||0)>(previous[field]?.length||0)?message[field]:previous[field];if(longest!==undefined)merged[field]=longest}
  messages.set(message.id,merged)
 }
 return {...next,messages:[...messages.values()].sort((a,b)=>number(a.createdAt)-number(b.createdAt))}
}
export function mergeHistory(current,incoming,deletedIds=[]){
 const deleted=new Set(deletedIds),records=new Map()
 for(const raw of [...current,...incoming]){const chat=normalizeConversation(raw);if(chat&&!deleted.has(chat.id))records.set(chat.id,mergeConversation(records.get(chat.id),chat))}
 return [...records.values()].sort((a,b)=>b.updated-a.updated)
}
export function loadBrowserHistory(storage){
 const chats=[],deletedIds=[]
 if(!storage)return {chats,deletedIds}
 try{const legacy=JSON.parse(storage.getItem(HISTORY_KEY)||'[]');if(Array.isArray(legacy))chats.push(...legacy)}catch{}
 try{
  for(let index=0;index<storage.length;index++){
   const key=storage.key(index)
   if(key?.startsWith(RECORD_PREFIX)){try{chats.push(JSON.parse(storage.getItem(key)))}catch{}}
   if(key?.startsWith(DELETED_PREFIX))deletedIds.push(key.slice(DELETED_PREFIX.length))
  }
 }catch{}
 return {chats:mergeHistory([],chats,deletedIds),deletedIds}
}
// Only the newest successful attempt for each user turn enters model context.
export function contextMessages(messages){
 const result=[]
 for(const message of messages){
  if(message.role==='user'){result.push(message);continue}
  if(message.error||message.interrupted||!message.content.trim())continue
  if(result.at(-1)?.role==='assistant')result[result.length-1]=message
  else result.push(message)
 }
 return result
}
