import http from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { parseEnv } from 'node:util'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { once } from 'node:events'
import { createSkillRegistry, defaultSkillSources } from './skills.mjs'
import { complete, STREAM_OPEN } from './completion.mjs'
import { createConversationRepository } from './conversations.mjs'
import { createRunManager } from './runs.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
export function normalizeBaseURL(value) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Base URL 必须是有效的 HTTP(S) 地址，不包含账号、查询参数或片段')
  return url.href.replace(/\/+$/, '')
}
function environment() {
  let file = {}
  try { file = parseEnv(readFileSync(path.join(root, '.env'), 'utf8')) } catch {}
  return { ...process.env, ...file }
}
function defaultConfig() {
  const env = environment()
  return { baseUrl: env.TOKENHUB_BASE_URL || 'https://test-stark.apuscn.com/v1', model: env.TOKENHUB_MODEL || 'deepseek-flash', apiKey: env.TOKENHUB_API_KEY || '' }
}
export function createApp({ initialConfig, fetchImpl = fetch, skillSources, conversationDirectory = path.join(root, '.data/conversations'), runDirectory = path.join(conversationDirectory,'..','runs'), recoverRuns = false } = {}) {
  const registry = createSkillRegistry(skillSources || defaultSkillSources(root, environment()))
  const conversations = createConversationRepository(conversationDirectory)
  let overrides = initialConfig || {}
  const config = () => ({ ...defaultConfig(), ...overrides })
  const publicConfig = () => { const c = config(); return { baseUrl: c.baseUrl, model: c.model, configured: Boolean(c.apiKey), provider: 'TokenHub · OpenAI 兼容' } }
  const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)) }
  const body = async (req, limit = 1024 * 1024) => {
    const chunks = []; let bytes = 0
    for await (const chunk of req) { bytes += chunk.length; if (bytes > limit) throw Object.assign(new Error('请求过大，请缩短上下文'), { status: 413 }); chunks.push(chunk) }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw Object.assign(new Error('无效的 JSON 请求'), { status: 400 }) }
  }
  const redacted = (value, key) => String(value || '').split(key || '\u0000').join('[REDACTED]').slice(0, 500)
  const runs=createRunManager({directory:runDirectory,conversations,generate:async function*(input,signal){const c=config();try{yield* complete({input,config:{...c,baseUrl:normalizeBaseURL(c.baseUrl)},registry,fetchImpl,signal})}catch(error){throw Object.assign(new Error(redacted(error.message,c.apiKey)),{status:error.status})}}})
  const recovered=recoverRuns?runs.recover():Promise.resolve()
  const server=http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      if (url.pathname.startsWith('/api/')) {
        if (req.headers.origin && !['http://127.0.0.1:3210', 'http://localhost:3210', 'http://127.0.0.1:5173', 'http://localhost:5173', `http://${req.headers.host}`].includes(req.headers.origin)) return json(res, 403, { error: '不允许的请求来源' })
        await recovered
        if(req.method==='POST'&&url.pathname==='/api/runs')return json(res,202,await runs.create(await body(req,16*1024*1024)))
        const runMatch=url.pathname.match(/^\/api\/runs\/([a-zA-Z0-9_-]{1,160})(?:\/(events|cancel))?$/)
        if(runMatch){
          const [,id,action]=runMatch
          if(req.method==='POST'&&action==='cancel')return json(res,200,await runs.cancel(id))
          if(req.method==='GET'&&!action)return json(res,200,await runs.get(id))
          if(req.method==='GET'&&action==='events'){
            await runs.get(id)
            res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders()
            let unsubscribe=()=>{},latest=null,blocked=false
            const deliver=run=>{if(res.destroyed)return;if(blocked){latest=run;return}blocked=!res.write(`id: ${run.sequence}\ndata: ${JSON.stringify({run})}\n\n`);if(run.status!=='running')res.end()}
            res.on('drain',()=>{blocked=false;if(latest){const value=latest;latest=null;deliver(value)}})
            const heartbeat=setInterval(()=>{if(!res.destroyed&&!blocked)blocked=!res.write(': keepalive\n\n')},15000);heartbeat.unref()
            res.on('close',()=>{clearInterval(heartbeat);unsubscribe()})
            unsubscribe=await runs.subscribe(id,Math.max(0,Number(url.searchParams.get('after')||req.headers['last-event-id'])||0),deliver)
            if(res.destroyed){clearInterval(heartbeat);unsubscribe()}
            return
          }
        }
        if (req.method === 'GET' && url.pathname === '/api/conversations') return json(res,200,await conversations.list(Math.max(0,Number(url.searchParams.get('since'))||0)))
        const conversationMatch=url.pathname.match(/^\/api\/conversations\/([a-zA-Z0-9_-]{1,160})$/)
        if(conversationMatch&&req.method==='PUT')return json(res,200,await conversations.save(conversationMatch[1],await body(req,16*1024*1024)))
        if(conversationMatch&&req.method==='DELETE')return json(res,200,await conversations.remove(conversationMatch[1]))
        if (req.method === 'GET' && url.pathname === '/api/skills') return json(res, 200, await registry.list(url.searchParams.get('refresh') === '1'))
        if (req.method === 'GET' && /^\/api\/skills\/[^/]+$/.test(url.pathname)) return json(res, 200, await registry.detail(url.pathname.split('/').at(-1)))
        if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, publicConfig())
        if (req.method === 'POST' && url.pathname === '/api/config') {
          const input = await body(req)
          const current = config()
          const baseUrl = normalizeBaseURL(input.baseUrl || current.baseUrl)
          const model = String(input.model || current.model).trim()
          if (!model || model.length > 160) return json(res, 400, { error: '请输入有效的模型 ID' })
          if (baseUrl !== normalizeBaseURL(current.baseUrl) && !input.apiKey) return json(res, 400, { error: '切换网关时请同时填写该网关的 API Key' })
          const apiKey = String(input.apiKey || current.apiKey).trim()
          if (/[\r\n]/.test(apiKey)) return json(res, 400, { error: 'API Key 格式无效' })
          overrides = { baseUrl, model, apiKey }
          return json(res, 200, publicConfig())
        }
        if (req.method === 'POST' && url.pathname === '/api/chat') {
          const input = await body(req)
          const c = config()
          const controller = new AbortController()
          res.on('close', () => { if (!res.writableEnded) controller.abort() })
          try {
            for await(const event of complete({input,config:{...c,baseUrl:normalizeBaseURL(c.baseUrl)},registry,fetchImpl,signal:controller.signal})){
              if(event===STREAM_OPEN){res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();continue}
              if(!res.write(`data: ${typeof event==='string'?event:JSON.stringify(event)}\n\n`))await once(res,'drain',{signal:controller.signal})
            }
            res.end()
          }catch(error){
            if(res.destroyed)return
            const message=redacted(controller.signal.aborted?'请求已停止或超时':error.message,c.apiKey)
            if(res.headersSent){res.write(`data: ${JSON.stringify({error:{message}})}\n\n`);res.end()}
            else json(res,error.status||502,{error:message})
          }
          return
        }
        return json(res, 404, { error: '接口不存在' })
      }
      if (!['GET','HEAD'].includes(req.method)) return json(res, 405, {error:'Method not allowed'})
      const dist = path.join(root, 'dist')
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '')
      let filename = path.resolve(dist, relative)
      if (filename !== dist && !filename.startsWith(dist + path.sep)) return json(res, 403, {error:'禁止访问'})
      if (relative.startsWith('.') || relative.split('/').some(s=>s.startsWith('.'))) return json(res,404,{error:'文件不存在'})
      if (!existsSync(dist)) return json(res, 503, {error:'请先执行 npm run build，或使用 npm run dev'})
      try { if (!(await stat(filename)).isFile()) filename = path.join(dist, 'index.html') } catch { filename = path.join(dist, 'index.html') }
      const types = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png' }
      res.writeHead(200, {'Content-Type':types[path.extname(filename)] || 'application/octet-stream','X-Content-Type-Options':'nosniff'})
      res.end(req.method === 'HEAD' ? undefined : await readFile(filename))
    } catch (error) { if (!res.headersSent) json(res, error.status || 400, {error:error.message}); else res.end() }
  })
  server.shutdownRuns=()=>runs.shutdown()
  return server
}
