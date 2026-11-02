import { useEffect, useRef, useSyncExternalStore } from 'react'
import { DELETED_PREFIX, RECORD_PREFIX, HISTORY_KEY, loadBrowserHistory, mergeHistory } from '../../shared/conversations.js'

export type Message = {id:string;role:'user'|'assistant';content:string;reasoning_content?:string;error?:string;interrupted?:boolean;revision?:number;createdAt?:number;replyTo?:string;runId?:string;runSequence?:number;runStatus?:'running'|'completed'|'failed'|'cancelled'|'interrupted';usage?:{total_tokens?:number};skill?:{id:string;name:string};resources?:{path:string;status:string;error?:string}[]}
export type Conversation = {id:string;title:string;messages:Message[];updated:number;skillId?:string;skillName?:string}
type Snapshot={chats:Conversation[];saveStatus:'loading'|'saved'|'saving'|'local'|'error'}
const starter=():Conversation=>({id:crypto.randomUUID(),title:'新对话',messages:[],updated:Date.now()})
function storage(){try{return window.localStorage}catch{return null}}
export function readActiveChat(){try{return storage()?.getItem('deepseek-chat-active')||''}catch{return ''}}
export function saveActiveChat(id:string){try{storage()?.setItem('deepseek-chat-active',id)}catch{}}
function createStore(){
 const browserStorage=storage(),initial=loadBrowserHistory(browserStorage)
 const deleted=new Set<string>(initial.deletedIds),pendingDeletes=new Set<string>(initial.deletedIds)
 let snapshot:Snapshot={chats:initial.chats.length?initial.chats:[starter()],saveStatus:'loading'}
 const bootstrapId=initial.chats.length?null:snapshot.chats[0].id
 const listeners=new Set<()=>void>(),dirty=new Map<string,Conversation>(),localDirty=new Map<string,Conversation>()
 let timer:ReturnType<typeof setTimeout>|undefined,interval:ReturnType<typeof setInterval>|undefined,flushing=false,ready=false,started=0,cursor=0,syncing:Promise<void>|null=null,storageOK=Boolean(browserStorage)
 const emit=(chats=snapshot.chats,saveStatus=snapshot.saveStatus)=>{if(chats===snapshot.chats&&saveStatus===snapshot.saveStatus)return;snapshot={chats,saveStatus};for(const callback of listeners)callback()}
 const ensureChat=(chats:Conversation[])=>chats.length?chats:[starter()]
 function persistLocal(){
  for(const [id,chat] of localDirty){try{if(!browserStorage)throw new Error('storage unavailable');browserStorage.setItem(RECORD_PREFIX+id,JSON.stringify(chat));localDirty.delete(id);storageOK=true}catch{storageOK=false}}
 }
 function schedule(){if(!timer&&started)timer=setTimeout(()=>{timer=undefined;void flush()},300)}
 function applyRemote(data:{conversations?:Conversation[];deletedIds?:string[];cursor?:number}){
  for(const id of data.deletedIds||[]){deleted.add(id);dirty.delete(id);localDirty.delete(id);try{browserStorage?.setItem(DELETED_PREFIX+id,'1');browserStorage?.removeItem(RECORD_PREFIX+id)}catch{}}
  const current=bootstrapId&&data.conversations?.length&&!dirty.has(bootstrapId)?snapshot.chats.filter(c=>c.id!==bootstrapId||c.messages.length):snapshot.chats
  const merged=ensureChat(mergeHistory(current,data.conversations||[],[...deleted]))
  for(const incoming of data.conversations||[]){const chat=merged.find(c=>c.id===incoming.id);if(chat)localDirty.set(chat.id,chat)}
  if(localDirty.size)schedule()
  cursor=Math.max(cursor,data.cursor||0)
  if(JSON.stringify(merged)!==JSON.stringify(snapshot.chats))emit(merged)
 }
 async function sync(){
  if(syncing)return syncing
  syncing=(async()=>{
   try{
    const response=await fetch(`/api/conversations?since=${cursor}`,{cache:'no-store'})
    if(!response.ok)throw new Error('history unavailable')
    const data=await response.json();applyRemote(data)
    if(!ready){ready=true;for(const chat of initial.chats){if(deleted.has(chat.id))continue;const merged=snapshot.chats.find(c=>c.id===chat.id);if(merged){dirty.set(chat.id,merged);localDirty.set(chat.id,merged)}}}
    if(dirty.size||pendingDeletes.size)schedule();else emit(undefined,'saved')
   }catch{emit(undefined,storageOK?'local':'error')}
  })().finally(()=>{syncing=null})
  return syncing
 }
 async function flush(){
  persistLocal()
  if(flushing)return
  flushing=true
  try{
   if(!ready)await sync()
   if(!ready)return
   for(const id of [...pendingDeletes]){
    const response=await fetch(`/api/conversations/${encodeURIComponent(id)}`,{method:'DELETE'})
    if(!response.ok)throw new Error('delete failed');pendingDeletes.delete(id)
   }
   for(const [id,chat] of [...dirty]){
    if(deleted.has(id)){dirty.delete(id);continue}
    const response=await fetch(`/api/conversations/${encodeURIComponent(id)}`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(chat)})
    if(response.status===409){applyRemote({deletedIds:[id]});continue}
    if(!response.ok)throw new Error('save failed')
    const data=await response.json()
    if(dirty.get(id)===chat)dirty.delete(id)
    applyRemote({conversations:[data.conversation]})
   }
   emit(undefined,dirty.size?'saving':'saved')
  }catch{emit(undefined,storageOK?'local':'error')}
  finally{flushing=false;if(dirty.size&&snapshot.saveStatus==='saving')schedule()}
 }
 const onStorage=(event:StorageEvent)=>{
  if(event.key&&!event.key.startsWith(RECORD_PREFIX)&&!event.key.startsWith(DELETED_PREFIX)&&event.key!==HISTORY_KEY)return
  const other=loadBrowserHistory(browserStorage)
  applyRemote({conversations:other.chats,deletedIds:other.deletedIds})
 }
 const onVisibility=()=>{if(document.visibilityState==='hidden'){persistLocal();void flush()}else void sync()}
 const onPageHide=()=>{persistLocal();void flush()}
 return {
  subscribe(callback:()=>void){listeners.add(callback);return()=>{listeners.delete(callback)}},
  getSnapshot:()=>snapshot,
  receiveRun(run:{conversationId:string;updated:number;message:Message}){const chat=snapshot.chats.find(c=>c.id===run.conversationId);if(chat)applyRemote({conversations:[{...chat,updated:Math.max(chat.updated,run.updated),messages:[run.message]}]})},
  update(updater:Conversation[]|((previous:Conversation[])=>Conversation[])){
   const previous=snapshot.chats,next=typeof updater==='function'?updater(previous):updater
   const old=new Map(previous.map(c=>[c.id,c])),ids=new Set(next.map(c=>c.id))
   for(const chat of previous)if(!ids.has(chat.id)){
    deleted.add(chat.id);pendingDeletes.add(chat.id);dirty.delete(chat.id);localDirty.delete(chat.id)
    try{browserStorage?.setItem(DELETED_PREFIX+chat.id,'1');browserStorage?.removeItem(RECORD_PREFIX+chat.id)
     const legacy=JSON.parse(browserStorage?.getItem(HISTORY_KEY)||'[]');if(Array.isArray(legacy))browserStorage?.setItem(HISTORY_KEY,JSON.stringify(legacy.filter(c=>c?.id!==chat.id)))
    }catch{}
   }
   const stamped=next.filter(c=>!deleted.has(c.id)).map(chat=>{
    const before=old.get(chat.id)
    if(before===chat)return chat
    const oldMessages=new Map(before?.messages.map(m=>[m.id,m])||[]),now=Date.now()
    const updated={...chat,updated:Math.max(now,(before?.updated||0)+1),messages:chat.messages.map((message,index)=>{
     const earlier=oldMessages.get(message.id)
     if(earlier===message)return message
     return {...message,createdAt:earlier?.createdAt||message.createdAt||now+index/1000,revision:Math.max(earlier?.revision||0,message.revision||0)+1}
    })}
    dirty.set(updated.id,updated);localDirty.set(updated.id,updated);return updated
   })
   emit(ensureChat(mergeHistory([],stamped,[...deleted])),'saving');persistLocal();schedule()
  },
  start(){
   started++;if(started>1)return
   window.addEventListener('storage',onStorage);window.addEventListener('pagehide',onPageHide);document.addEventListener('visibilitychange',onVisibility)
   void sync();interval=setInterval(()=>{void sync();if(dirty.size||pendingDeletes.size)void flush()},3000)
   if(dirty.size)schedule()
  },
  stop(){started=Math.max(0,started-1);if(started)return
   window.removeEventListener('storage',onStorage);window.removeEventListener('pagehide',onPageHide);document.removeEventListener('visibilitychange',onVisibility)
   if(timer){clearTimeout(timer);timer=undefined}if(interval)clearInterval(interval)
   persistLocal();if(dirty.size||pendingDeletes.size)void flush()
  },
 }
}
export function useConversations(){
 const store=useRef<ReturnType<typeof createStore>|null>(null)
 if(!store.current)store.current=createStore()
 const current=store.current,snapshot=useSyncExternalStore(current.subscribe,current.getSnapshot)
 useEffect(()=>{current.start();return()=>current.stop()},[current])
 return {...snapshot,setChats:current.update,receiveRun:current.receiveRun}
}
