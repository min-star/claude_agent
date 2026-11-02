import { mkdir, readdir, readFile, open, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { validId, normalizeConversation, mergeConversation } from '../shared/conversations.js'
const failure=(message,status=400)=>Object.assign(new Error(message),{status})
export function createConversationRepository(directory){
 let queue=Promise.resolve(),stamp=0
 const serial=operation=>{const result=queue.then(operation);queue=result.catch(()=>{});return result}
 const file=id=>{if(!validId(id))throw failure('无效的会话 ID');return path.join(directory,id+'.json')}
 async function read(id){try{return JSON.parse(await readFile(file(id),'utf8'))}catch(e){if(e.code==='ENOENT')return null;throw failure('会话存储无法读取，原文件已保留',500)}}
 async function write(id,record){
  await mkdir(directory,{recursive:true,mode:0o700})
  const temporary=path.join(directory,`.${id}.${randomUUID()}.tmp`)
  try{const handle=await open(temporary,'wx',0o600);try{await handle.writeFile(JSON.stringify(record));await handle.sync()}finally{await handle.close()}await rename(temporary,file(id))}finally{await unlink(temporary).catch(()=>{})}
 }
 return {
  list(since=0){return serial(async()=>{
   let entries;try{entries=await readdir(directory)}catch(e){if(e.code==='ENOENT')return {conversations:[],deletedIds:[],cursor:stamp};throw e}
   const conversations=[],deletedIds=[]
   for(const name of entries){if(!name.endsWith('.json')||!validId(name.slice(0,-5)))continue
    const record=await read(name.slice(0,-5));stamp=Math.max(stamp,record.savedAt||0)
    if((record.savedAt||0)<=since)continue
    if(record.deleted)deletedIds.push(record.id)
    else {const chat=normalizeConversation(record.conversation);if(chat)conversations.push(chat)}
   }
   return {conversations,deletedIds,cursor:stamp}
  })},
  save(id,input){return serial(async()=>{
   const incoming=normalizeConversation(input)
   if(!incoming||incoming.id!==id)throw failure('会话格式无效')
   const previous=await read(id)
   if(previous?.deleted)throw failure('该会话已在其他页面删除',409)
   const current=previous?normalizeConversation(previous.conversation):null
   if(previous&&!current)throw failure('原会话数据异常，已保留原文件',500)
   const conversation=mergeConversation(current,incoming)
   stamp=Math.max(Date.now(),stamp+1,(previous?.savedAt||0)+1)
   await write(id,{id,savedAt:stamp,conversation})
   return {conversation}
  })},
  remove(id){return serial(async()=>{
   const previous=await read(id);stamp=Math.max(Date.now(),stamp+1,(previous?.savedAt||0)+1)
   await write(id,{id,deleted:true,savedAt:stamp})
   return {id,deleted:true}
  })},
 }
}
