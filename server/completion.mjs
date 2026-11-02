import { readSSE } from '../shared/sse.js'
import { skillSystemMessage } from './skills.mjs'
import { skillTools, createToolAccumulator, runSkillTool } from './skill-tools.mjs'
export const STREAM_OPEN=Symbol('stream-open')
const fail=(message,status=502)=>Object.assign(new Error(message),{status})
export async function* complete({input,config:c,registry,fetchImpl,signal}){
 if(!c.apiKey)throw fail('尚未配置 API Key，请点击左下角「模型设置」完成接入。',503)
 if(!Array.isArray(input.messages)||!input.messages.length||input.messages.length>200||input.messages.some(m=>!m||!['user','assistant','system'].includes(m.role)||typeof m.content!=='string'||m.content.length>300000||(m.reasoning_content!==undefined&&typeof m.reasoning_content!=='string')))throw fail('消息格式无效或上下文过长，请新建对话',400)
 const skill=input.skillId?await registry.get(input.skillId):null
 const messages=input.messages.map(({role,content,reasoning_content})=>({role,content,...(role==='assistant'&&reasoning_content?{reasoning_content}:{})}))
 if(skill)messages.splice(messages[0]?.role==='system'?1:0,0,skillSystemMessage(skill,messages.findLast(m=>m.role==='user')?.content||''))
 const idle=new AbortController(),combined=AbortSignal.any([signal,idle.signal])
 const timeout=setTimeout(()=>idle.abort(new Error('模型响应超时，请稍后重试')),180000)
 const totalUsage={prompt_tokens:0,completion_tokens:0,total_tokens:0};let hasUsage=false,opened=false
 try{
  for(let round=0;round<4;round++){
   combined.throwIfAborted()
   const upstream=await fetchImpl(c.baseUrl.replace(/\/+$/,'')+'/chat/completions',{method:'POST',signal:combined,headers:{'Content-Type':'application/json',Authorization:`Bearer ${c.apiKey}`},body:JSON.stringify({model:c.model,messages,stream:true,stream_options:{include_usage:true},max_tokens:200000,thinking:{type:input.thinking?'enabled':'disabled'},...(skill?{tools:skillTools,tool_choice:'auto'}:{})})})
   if(!upstream.ok){
    let message='';try{const data=JSON.parse(await upstream.text());message=data.error?.message||data.message||''}catch{}
    const hint={401:'API Key 无效或已过期',403:'当前 Key 无权调用该模型',404:'模型或接口地址不存在',429:'调用过于频繁或额度不足'}[upstream.status]||'模型服务请求失败'
    throw fail(`${hint}（${upstream.status}）${message?'：'+String(message).split(c.apiKey).join('[REDACTED]').slice(0,500):''}`,upstream.status)
   }
   if(!upstream.body||!upstream.headers.get('content-type')?.includes('text/event-stream'))throw fail('网关未返回 SSE 流，请检查 OpenAI 兼容接口地址')
   if(!opened){opened=true;yield STREAM_OPEN;if(skill)yield {skill:{id:skill.id,name:skill.name}}}
   const accumulator=createToolAccumulator();let finished=false,content='',reasoning='',finishReason=''
   for await(const event of readSSE(upstream.body)){
    combined.throwIfAborted();timeout.refresh()
    if(event==='[DONE]'){finished=true;break}
    let data;try{data=JSON.parse(event)}catch{throw fail('网关返回了无效的流式数据')}
    if(data.error)throw fail(data.error.message||'上游流式响应失败')
    const choice=data.choices?.[0],delta=choice?.delta
    content+=delta?.content||'';reasoning+=delta?.reasoning_content||''
    if(choice?.finish_reason)finishReason=choice.finish_reason
    if(delta?.tool_calls)accumulator.add(delta.tool_calls)
    if(data.usage){hasUsage=true;for(const key of Object.keys(totalUsage))totalUsage[key]+=Number(data.usage[key])||0;delete data.usage}
    yield data
   }
   if(!finished)throw fail('连接提前中断，回复可能不完整，请手动重试')
   const calls=accumulator.finish()
   if(!calls.length){if(finishReason==='tool_calls')throw fail('模型返回工具结束状态但缺少完整调用');if(hasUsage)yield {choices:[],usage:totalUsage};yield '[DONE]';return}
   if(!skill)throw fail('未选择技能，不能调用技能参考工具')
   if(round===3)throw fail('技能参考读取已达轮次上限，请缩小任务范围后重试')
   if(finishReason!=='tool_calls')throw fail('工具调用未正常结束，未执行参考读取')
   messages.push({role:'assistant',content:content||null,...(reasoning?{reasoning_content:reasoning}:{}),tool_calls:calls})
   for(const call of calls){combined.throwIfAborted();const result=await runSkillTool(call,skill,registry);messages.push(result);const resource=JSON.parse(result.content);yield {skill_file:{path:resource.path||'参考资料',status:resource.error?'error':'read',...(resource.error?{error:resource.error}:{})}}}
  }
 }finally{clearTimeout(timeout)}
}
