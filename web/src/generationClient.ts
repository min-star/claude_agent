import { readSSE } from '../../shared/sse.js'
import type { Message,Conversation } from './conversationStore'
export type Run={id:string;conversationId:string;messageId:string;sequence:number;status:NonNullable<Message['runStatus']>;updated:number;message:Message}
export type StartRun={id:string;conversationId:string;messageId:string;conversation:Conversation;request:{messages:unknown[];thinking:boolean;skillId?:string}}
const pause=(ms:number,signal:AbortSignal)=>new Promise<void>((resolve,reject)=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);resolve()};const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(signal.reason)};const timer=setTimeout(done,ms);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort()})
export async function startRun(input:StartRun):Promise<Run>{
 const body=JSON.stringify(input)
 for(let attempt=0;;attempt++){
  try{const response=await fetch('/api/runs',{method:'POST',headers:{'Content-Type':'application/json'},body,signal:AbortSignal.timeout(15000)});const data=await response.json();if(!response.ok)throw Object.assign(new Error(data.error||'创建生成任务失败'),{status:response.status});return data}
  catch(error){const status=(error as {status?:number}).status;if(attempt>=2||(status&&status<500))throw error;await new Promise(resolve=>setTimeout(resolve,500*(attempt+1)))}
 }
}
export async function followRun(id:string,onSnapshot:(run:Run)=>void,onConnection:(reconnecting:boolean)=>void,signal:AbortSignal){
 let sequence=0,attempt=0;const started=Date.now()
 while(!signal.aborted){
  const connection=new AbortController();let idle:ReturnType<typeof setTimeout>|undefined
  const activity=()=>{if(idle)clearTimeout(idle);idle=setTimeout(()=>connection.abort(new Error('生成订阅超时')),45000)}
  try{
   activity()
   const response=await fetch(`/api/runs/${encodeURIComponent(id)}/events?after=${sequence}`,{headers:{'Last-Event-ID':String(sequence)},signal:AbortSignal.any([signal,connection.signal]),cache:'no-store'})
   if(!response.ok){const data=await response.json().catch(()=>({}));throw Object.assign(new Error(data.error||'生成订阅失败'),{status:response.status})}
   if(!response.body)throw new Error('浏览器不支持流式响应')
   onConnection(false);attempt=0
   for await(const event of readSSE(response.body,activity)){
    const run=JSON.parse(event).run as Run
    if(!run||run.id!==id||!Number.isFinite(run.sequence))throw new Error('生成进度格式无效')
    if(run.sequence>sequence){sequence=run.sequence;onSnapshot(run)}
    if(run.status!=='running')return
   }
   throw new Error('生成订阅连接中断')
  }catch(error){
   if(signal.aborted)return
   const status=(error as {status?:number}).status
   if(status===401||status===403||(status===404&&Date.now()-started>30000))throw error
   onConnection(true);await pause(Math.min(1000*2**attempt++,15000),signal)
  }finally{if(idle)clearTimeout(idle);connection.abort()}
 }
}
export async function cancelRun(id:string):Promise<Run>{const response=await fetch(`/api/runs/${encodeURIComponent(id)}/cancel`,{method:'POST',signal:AbortSignal.timeout(15000)});const data=await response.json();if(!response.ok)throw new Error(data.error||'停止生成失败');return data}
