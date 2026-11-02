import assert from 'node:assert/strict'
import { createApp } from '../server/app.mjs'
import { readSSE } from '../shared/sse.js'
const app = createApp()
await new Promise(r=>app.listen(0,'127.0.0.1',r))
const base = `http://127.0.0.1:${app.address().port}`
try {
  const config = await (await fetch(`${base}/api/config`)).json()
  assert(config.configured,'请在 .env 中配置 TOKENHUB_API_KEY')
  console.log(`Live model: ${config.model}; gateway: ${config.baseUrl}`)
  async function chat(messages,thinking=false){
    const start=Date.now()
    const response=await fetch(`${base}/api/chat`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages,thinking}),signal:AbortSignal.timeout(180000)})
    if(!response.ok)throw new Error(`HTTP ${response.status}: ${await response.text()}`)
    let content='',reasoning='',done=false,usage=null
    for await(const event of readSSE(response.body)){
      if(event==='[DONE]'){done=true;break}
      const data=JSON.parse(event);if(data.error)throw new Error(data.error.message)
      const delta=data.choices?.[0]?.delta
      content+=delta?.content||'';reasoning+=delta?.reasoning_content||''
      if(data.usage)usage=data.usage
    }
    assert(done,'缺失 SSE [DONE]');assert(content.trim(),'未收到真实模型正文')
    console.log(JSON.stringify({thinking,content,reasoningCharacters:reasoning.length,usage,durationMs:Date.now()-start}))
    return {content,reasoning}
  }
  const first=[{role:'user',content:'请记住测试代号：青竹731。只回复“已记住”。'}]
  const answer=await chat(first)
  const second=await chat([...first,{role:'assistant',content:answer.content},{role:'user',content:'刚才的测试代号是什么？只回复代号。'}])
  assert(second.content.includes('青竹731'),'多轮上下文测试失败')
  const reasoning=await chat([{role:'user',content:'计算 17×23，只给出最后的数字。'}],true)
  assert(reasoning.content.includes('391'),'思考模式答案不正确')
  assert(reasoning.reasoning.length>0,'思考模式没有返回 reasoning_content')
  console.log('PASS: 真实流式回复、多轮上下文、深度思考、用量与结束标记。')
} finally { app.closeAllConnections();await new Promise(r=>app.close(r)) }
