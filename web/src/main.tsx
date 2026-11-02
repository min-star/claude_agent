import React, { memo, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowUp, Brain, Check, ChevronDown, ChevronRight, Code2, Copy, Download, FileText, LoaderCircle, MessageCircle, PanelLeftClose, PanelLeftOpen, PencilLine, Plus, Search, Settings, Sparkles, Square, Trash2, X, Zap } from 'lucide-react'
import { startRun, followRun, cancelRun, type Run } from './generationClient'
import { SkillsDialog, type SkillCatalog, type SkillSummary } from './SkillsDialog'
import { useConversations, readActiveChat, saveActiveChat, type Message, type Conversation } from './conversationStore'
import { contextMessages } from '../../shared/conversations.js'
import { chatErrorMessage } from '../../shared/chat-errors.js'
import './styles.css'

type Config = { baseUrl: string; model: string; configured: boolean; provider: string }
const uid = () => crypto.randomUUID()
const starter = (): Conversation => ({ id: uid(), title: '新对话', messages: [], updated: Date.now() })
const markdownPlugins=[remarkGfm]
const markdownComponents={a:(props:React.ComponentProps<'a'>)=><a {...props} target="_blank" rel="noopener noreferrer"/>}
const MessageContent=memo(function MessageContent({content,streaming}:{content:string;streaming:boolean}){
  return streaming?<div className="streaming-text">{content}</div>:<Markdown remarkPlugins={markdownPlugins} components={markdownComponents}>{content}</Markdown>
})
const prompts = [
  { icon: PencilLine, label: '帮我写作', hint: '让灵感变成好文字', prompt: '帮我写一篇简洁、有感染力的文章。请先问我写作主题、读者和期望字数。', color: 'purple' },
  { icon: Code2, label: '编程助手', hint: '一起解决代码难题', prompt: '我想请你帮忙分析一段代码。请先问我使用的语言和遇到的问题。', color: 'blue' },
  { icon: FileText, label: '学习搭子', hint: '把复杂知识讲明白', prompt: '我想学习一个新知识。请先问我想学什么、当前基础和学习目标。', color: 'orange' },
  { icon: Sparkles, label: '创意灵感', hint: '发现不一样的好点子', prompt: '我想和你一起头脑风暴。请先问我希望探索的主题，并帮我发现新角度。', color: 'green' },
]
function App() {
  const {chats,setChats,saveStatus,receiveRun}=useConversations()
  const [activeId,setActiveId] = useState(()=>readActiveChat()||chats[0].id)
  const [draft,setDraft] = useState('')
  const [thinking,setThinking] = useState(false)
  const [mode,setMode] = useState<'chat'|'work'>('chat')
  const [sidebar,setSidebar] = useState(()=>window.innerWidth>760)
  const [search,setSearch] = useState<string|null>(null)
  const [settings,setSettings] = useState(false)
  const [skillsOpen,setSkillsOpen] = useState(false)
  const [catalog,setCatalog] = useState<SkillCatalog>({skills:[],sources:[],warnings:[]})
  const [skillsLoading,setSkillsLoading] = useState(false)
  const [skillsError,setSkillsError] = useState('')
  const [config,setConfig] = useState<Config|null>(null)
  const running=chats.find(c=>c.messages.some(m=>m.runStatus==='running'))?.id||null
  const [reconnecting,setReconnecting]=useState<Set<string>>(()=>new Set())
  const [toast,setToast] = useState('')
  const [copied,setCopied] = useState('')
  const [deleteId,setDeleteId] = useState<string|null>(null)
  const subscriptions=useRef(new Map<string,AbortController>())
  const creations=useRef(new Map<string,Promise<Run>>())
  const scrollArea = useRef<HTMLDivElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const follow = useRef(true)
  const chat = chats.find(c=>c.id===activeId)||chats[0]
  const selectedSkill = catalog.skills.find(s=>s.id===chat.skillId)
  const slashQuery = draft.startsWith('/') && !/\s/.test(draft) ? draft.slice(1).toLowerCase() : null
  const slashSkills = slashQuery!==null ? catalog.skills.filter(s=>s.name.toLowerCase().includes(slashQuery)).slice(0,6) : []
  const empty = !chat.messages.length
  const busy = Boolean(running)
  const notify = (text:string) => { setToast(text); window.setTimeout(()=>setToast(''),3500) }
  useEffect(()=>{ const query=window.matchMedia('(max-width: 760px)');const resize=(e:MediaQueryListEvent)=>setSidebar(!e.matches);query.addEventListener('change',resize);return()=>query.removeEventListener('change',resize) },[])
  async function loadSkills(refresh=false){setSkillsLoading(true);setSkillsError('');try{const res=await fetch(`/api/skills${refresh?'?refresh=1':''}`);const data=await res.json();if(!res.ok)throw new Error(data.error||'技能加载失败');setCatalog(data)}catch(e){setSkillsError(e instanceof Error?e.message:'技能加载失败')}finally{setSkillsLoading(false)}}
  useEffect(()=>{void loadSkills()},[])
  useEffect(()=>{ fetch('/api/config').then(r=>r.json()).then(setConfig).catch(()=>notify('服务连接失败，请检查后端是否运行')) },[])
  useEffect(()=>{if(chats.some(c=>c.id===activeId))saveActiveChat(activeId);else if(saveStatus!=='loading'){saveActiveChat(chat.id);setActiveId(chat.id)}},[chats,chat.id,activeId,saveStatus])
  useEffect(()=>{ if(follow.current && scrollArea.current) scrollArea.current.scrollTop=scrollArea.current.scrollHeight },[chat.messages])
  useEffect(()=>{ const key=(e:KeyboardEvent)=>{ if((e.metaKey||e.ctrlKey)&&e.key==='k'){e.preventDefault();newChat()} if(e.key==='Escape'){setSettings(false);setSearch(null);setDeleteId(null);setSkillsOpen(false)} };window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key) },[chats])
  const updateChat = (id:string, update:(c:Conversation)=>Conversation) => setChats(prev=>prev.map(c=>c.id===id?update(c):c))
  function newChat() { const existing=chats.find(c=>!c.messages.length);if(existing){setActiveId(existing.id);updateChat(existing.id,c=>({...c,skillId:undefined,skillName:undefined}))}else{const next=starter();setChats(prev=>[next,...prev]);setActiveId(next.id)}setDraft('');setMode('chat');if(innerWidth<761)setSidebar(false);textarea.current?.focus() }
  function selectChat(id:string){setActiveId(id);setSearch(null);follow.current=true;if(innerWidth<761)setSidebar(false)}
  function chooseSkill(skill:SkillSummary){updateChat(chat.id,c=>({...c,skillId:skill.id,skillName:skill.name}));setSkillsOpen(false);textarea.current?.focus()}
  function clearSkill(){updateChat(chat.id,c=>({...c,skillId:undefined,skillName:undefined}))}
  async function send(text=draft, retryMessages?:Message[], resume?:Message) {
    if(busy||!text.trim())return
    let skill=retryMessages ? retryMessages.at(-1)?.skill : chat.skillId ? {id:chat.skillId,name:chat.skillName||selectedSkill?.name||'技能'} : undefined
    if(!retryMessages&&text.startsWith('/')){
      const found=[...catalog.skills].sort((a,b)=>b.name.length-a.name.length).find(s=>text===`/${s.name}`||text.startsWith(`/${s.name} `)||text.startsWith(`/${s.name}\n`))
      if(!found){setSkillsOpen(true);notify('未找到该技能，请从技能库选择');return}
      skill={id:found.id,name:found.name};text=text.slice(found.name.length+1).trim()||'请按所选技能处理当前对话。';chooseSkill(found)
    }
    if(skill&&!catalog.skills.some(s=>s.id===skill.id)){setSkillsOpen(true);notify('当前技能已不可用，请刷新或重新选择');return}
    if(!config?.configured){setSettings(true);notify('先配置 API Key，即可开始真实对话');return}
    const id=chat.id,runId=uid(),now=Date.now()
    const user:Message={id:uid(),role:'user',content:text.trim(),createdAt:now,...(skill?{skill}:{})}
    const history=resume?[...retryMessages!,user]:retryMessages || [...chat.messages,user]
    const assistant:Message={...(resume||{id:uid(),role:'assistant',content:'',reasoning_content:'',replyTo:history.at(-1)?.id,createdAt:now+0.001,...(skill?{skill}:{})}),error:undefined,interrupted:undefined,revision:(resume?.revision||0)+1,runId,runSequence:0,runStatus:'running'}
    const conversation:Conversation={...chat,title:chat.messages.length?chat.title:text.trim().slice(0,22),updated:now,messages:resume?chat.messages.map(m=>m.id===resume.id?assistant:m):retryMessages?[...chat.messages,assistant]:[...history,assistant]}
    const request={thinking,...(skill?{skillId:skill.id}:{}),messages:[{role:'system',content:mode==='work'?'你是一位可靠的中文工作助手。帮助用户将任务拆成清晰步骤，并产出可直接使用的结果。你可以进行文本对话，使用所选技能并读取其文本参考资料；不能执行终端、写入文件或调用外部服务，不得声称完成不可用操作。':'你是一位友好、准确的中文智能助手，使用清晰自然的语言回答。你可以进行文本对话，使用所选技能并读取其文本参考资料；不能执行终端、写入文件或调用外部服务，不得声称完成不可用操作。'},...contextMessages(history).map(({role,content,reasoning_content})=>({role,content,...(reasoning_content?{reasoning_content}:{})}))]}
    const creation=startRun({id:runId,conversationId:id,messageId:assistant.id,conversation,request});creations.current.set(runId,creation)
    updateChat(id,()=>conversation)
    setDraft('');follow.current=true
    if(textarea.current)textarea.current.style.height='auto'
    try{receiveRun(await creation)}catch(error){updateChat(id,c=>({...c,messages:c.messages.map(m=>m.runId===runId&&!m.runSequence?{...m,runStatus:'failed',error:chatErrorMessage(error,Boolean(m.content))}:m)}))}
    finally{creations.current.delete(runId);textarea.current?.focus()}
  }
  useEffect(()=>{
    const active=new Set<string>()
    for(const conversation of chats)for(const message of conversation.messages){
      if(!message.runId||message.runStatus!=='running')continue
      const id=message.runId;active.add(id)
      if(!message.runSequence&&creations.current.has(id))continue
      if(subscriptions.current.has(id))continue
      const controller=new AbortController();subscriptions.current.set(id,controller)
      const connection=(retrying:boolean)=>setReconnecting(previous=>{if(previous.has(id)===retrying)return previous;const next=new Set(previous);if(retrying)next.add(id);else next.delete(id);return next})
      void followRun(id,receiveRun,connection,controller.signal).catch(error=>{
        if(!controller.signal.aborted)updateChat(conversation.id,c=>({...c,messages:c.messages.map(m=>m.runId===id&&m.runStatus==='running'?{...m,runStatus:'interrupted',error:chatErrorMessage(error,Boolean(m.content))}:m)}))
      }).finally(()=>{if(subscriptions.current.get(id)===controller)subscriptions.current.delete(id);connection(false)})
    }
    for(const [id,controller] of subscriptions.current)if(!active.has(id)){controller.abort();subscriptions.current.delete(id)}
  },[chats,receiveRun])
  useEffect(()=>()=>{for(const controller of subscriptions.current.values())controller.abort();subscriptions.current.clear()},[])
  async function stopGeneration(){
    const message=chats.find(c=>c.id===running)?.messages.slice().reverse().find(m=>m.runStatus==='running')
    if(!message?.runId)return
    try{await creations.current.get(message.runId);receiveRun(await cancelRun(message.runId))}catch(error){notify(error instanceof Error?error.message:'停止生成失败，请重试')}
  }
  function continueAnswer(message:Message){
    const index=chat.messages.findIndex(m=>m.id===message.id)
    const history=chat.messages.slice(0,index+1).map(m=>m.id===message.id?{...m,error:undefined,interrupted:undefined}:m)
    void send('请从上条回答中断的位置直接继续，保持原结构与内容衔接，不要重写或重复已输出的部分。',history,message)
  }
  async function copy(message:Message){try{await navigator.clipboard.writeText(message.content);setCopied(message.id);setTimeout(()=>setCopied(''),1800)}catch{notify('复制失败，请手动选择文字')}}
  function exportChat(){ const text=chat.messages.map(m=>`## ${m.role==='user'?'你':'DeepSeek'}\n\n${m.content}${m.error?`\n\n> 错误：${m.error}`:''}`).join('\n\n');const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([`# ${chat.title}\n\n${text}`],{type:'text/markdown;charset=utf-8'}));a.download=`${chat.title.replace(/[\\/:*?"<>|]/g,'_')}.md`;a.click();URL.revokeObjectURL(a.href);notify('对话已导出') }
  return <div className={`app ${sidebar?'sidebar-open':'sidebar-closed'}`}>
    {sidebar&&<button className="sidebar-scrim" aria-label="关闭侧栏" onClick={()=>setSidebar(false)}/>}
    <aside className="sidebar" aria-label="侧栏"><div className="brand-row"><button className="brand" onClick={newChat}><img src="/favicon.svg" alt=""/>DeepSeek<span>Chat</span></button><button className="icon-button" aria-label="搜索对话" onClick={()=>setSearch('')}><Search size={19}/></button></div>
      <button className="new-chat" onClick={newChat}><PencilLine size={19}/><span>新对话</span><kbd>⌘ K</kbd></button>
      <nav className="main-nav"><button onClick={()=>{newChat();setMode('work')}}><Sparkles size={19}/><span>新工作任务</span><span className="new-label">NEW</span></button><button onClick={()=>{setSettings(true)}}><Zap size={19}/><span>模型服务</span><ChevronRight size={15}/></button><button onClick={()=>setSkillsOpen(true)}><Sparkles size={19}/><span>技能库</span><span className="skills-count">{catalog.skills.length||'Skills'}</span></button></nav>
      <div className="history"><div className="section-label">最近对话<span>{chats.filter(c=>c.messages.length).length||''}</span></div>{chats.filter(c=>c.messages.length).length===0?<div className="history-empty"><MessageCircle size={22}/><p>从一个问题开始</p><span>对话会自动保存在这台设备</span></div>:chats.filter(c=>c.messages.length).sort((a,b)=>b.updated-a.updated).map(c=><div key={c.id} className={`history-row ${c.id===chat.id?'active':''}`}><button className="history-title" onClick={()=>selectChat(c.id)}><MessageCircle size={16}/><span>{c.title}</span>{running===c.id&&<LoaderCircle size={13} className="spin"/>}</button><button className="delete-chat icon-button" aria-label={`删除对话 ${c.title}`} onClick={()=>setDeleteId(c.id)} disabled={running===c.id}><Trash2 size={14}/></button></div>)}</div>
      <div className="sidebar-bottom"><div className="model-card"><div className="model-badge"><Zap size={15}/></div><div><strong>DeepSeek Flash</strong><span><i className={config?.configured?'connected':''}/>{config?.configured?'已配置 · TokenHub':'等待配置 API Key'}</span></div><span className="version">4.1</span></div><button className="account" onClick={()=>setSettings(true)}><span className="avatar">我</span><span>本地工作空间<small>让每个想法，都有回应</small></span><Settings size={18}/></button></div>
    </aside>
    <main className="main"><header className="topbar"><div className="topbar-left"><button className="icon-button" aria-label={sidebar?'收起侧栏':'展开侧栏'} onClick={()=>setSidebar(!sidebar)}>{sidebar?<PanelLeftClose size={20}/>:<PanelLeftOpen size={20}/>}</button><button className="model-selector" onClick={()=>setSettings(true)}>DeepSeek Flash<ChevronDown size={14}/><span className="flash-tag"><Zap size={10}/>快速</span></button></div><div className="topbar-right"><span className={`connection ${config?.configured?'ready':''}`}><i/>{config?.configured?'模型已配置':'未连接模型'}</span>{!empty&&<button className="icon-button" aria-label="导出对话" onClick={exportChat}><Download size={18}/></button>}<button className="icon-button" aria-label="模型设置" onClick={()=>setSettings(true)}><Settings size={18}/></button></div></header>
      <div className={`chat-scroll ${empty?'is-empty':''}`} ref={scrollArea} onScroll={e=>{const el=e.currentTarget;follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<100}}>
        {empty?<section className="welcome"><div className="greeting-icon"><img src="/favicon.svg" alt="DeepSeek"/></div><h1>{mode==='chat'?'有什么我能帮你的吗？':'今天有什么工作要处理？'}</h1><p className="welcome-subtitle">和 DeepSeek 一起，让想法更进一步</p><div className="mode-switch" aria-label="对话模式"><button aria-pressed={mode==='chat'} className={mode==='chat'?'selected':''} onClick={()=>setMode('chat')}><MessageCircle size={16}/>对话</button><button aria-pressed={mode==='work'} className={mode==='work'?'selected':''} onClick={()=>setMode('work')}><Sparkles size={16}/>工作</button></div><div className="suggestions"><div className="suggestion-label">从这里开始 <span>一点灵感，无限可能</span></div><div className="prompt-grid">{prompts.map(p=><button key={p.label} onClick={()=>{setDraft(p.prompt);textarea.current?.focus()}}><span className={`prompt-icon ${p.color}`}><p.icon size={18}/></span><strong>{p.label}</strong><span>{p.hint}</span><ChevronRight size={14}/></button>)}</div></div></section>:<div className="messages" aria-live="polite">{chat.messages.map((m,index)=><article key={m.id} className={`message ${m.role}`}><div className="message-avatar">{m.role==='assistant'?<img src="/favicon.svg" alt="DeepSeek"/>:'你'}</div><div className="message-main">{m.role==='assistant'&&<div className="assistant-name">DeepSeek <span>Flash</span>{m.skill&&<span className="message-skill"><Sparkles size={10}/>{m.skill.name}</span>}</div>}{m.reasoning_content&&<details className="reasoning" open={running===chat.id&&index===chat.messages.length-1&&!m.content}><summary><Brain size={15}/>{running===chat.id&&index===chat.messages.length-1&&!m.content?'正在深度思考…':'思考过程'}<ChevronDown size={13}/></summary><div>{m.reasoning_content}</div></details>}{m.resources&&m.resources.length>0&&<details className="skill-resources"><summary><FileText size={13}/>技能参考资料 · {m.resources.length}</summary>{m.resources.map((r,i)=><div key={i}><span>{r.status==='read'?'已读取':'读取失败'}</span><code>{r.path}</code>{r.error&&<small>{r.error}</small>}</div>)}</details>}{m.content&&<div className="message-content"><MessageContent content={m.content} streaming={running===chat.id&&index===chat.messages.length-1}/></div>}{m.role==='assistant'&&!m.content&&!m.error&&!m.interrupted&&running===chat.id&&<div className="typing"><span/><span/><span/></div>}{m.error&&<div className="message-error" role="alert">{chatErrorMessage(m.error,Boolean(m.content.trim()))}</div>}{m.interrupted&&<div className="interrupted">已停止生成</div>}{m.role==='assistant'&&!(running===chat.id&&index===chat.messages.length-1)&&<div className="message-actions">{m.content&&<button aria-label="复制回答" onClick={()=>copy(m)}>{copied===m.id?<Check size={15}/>:<Copy size={15}/>}</button>}{index===chat.messages.length-1&&m.content&&(m.error||m.interrupted)&&<button className="retry" disabled={busy} onClick={()=>continueAnswer(m)}>继续生成</button>}{index===chat.messages.length-1&&<button className="retry" disabled={busy} onClick={()=>{const history=chat.messages.slice(0,index);while(history.length&&history.at(-1)?.role!=='user')history.pop();send(history.at(-1)?.content||'',history)}}><span>↻</span> 重新生成</button>}{m.usage?.total_tokens&&<span className="tokens">{m.usage.total_tokens.toLocaleString()} tokens</span>}</div>}</div></article>)}</div>}
      </div>
      <div className="composer-area">{chat.skillId&&<div className="active-skill"><Sparkles size={13}/><span>当前技能</span><strong>{selectedSkill?.name||chat.skillName||'技能不可用'}</strong><button aria-label="查看当前技能" onClick={()=>setSkillsOpen(true)}>查看</button><button className="icon-button" aria-label="取消当前技能" disabled={busy} onClick={clearSkill}><X size={13}/></button></div>}{slashQuery!==null&&<div className="slash-menu" aria-label="技能命令建议">{slashSkills.map(s=><button key={s.id} onClick={()=>{chooseSkill(s);setDraft(`/${s.name} `)}}><Sparkles size={14}/><span>/{s.name}<small>{s.description}</small></span></button>)}{!slashSkills.length&&<span>没有匹配的技能</span>}</div>}<div className={`composer ${busy?'generating':''}`}><textarea ref={textarea} value={draft} aria-label="发送消息" placeholder={mode==='chat'?'发消息，或聊聊你的想法…':'描述你的任务，让我们一起完成…'} rows={2} onChange={e=>{setDraft(e.target.value);e.target.style.height='auto';e.target.style.height=Math.min(e.target.scrollHeight,200)+'px'}} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void send()}}}/><div className="composer-toolbar"><div className="composer-tools"><button className="icon-button attachment" aria-label="添加文本文件" title="添加文本文件" onClick={()=>document.getElementById('text-file')?.click()}><Plus size={22}/></button><input id="text-file" type="file" accept=".txt,.md,.csv,.json,.js,.ts,.tsx,.py,.html,.css" hidden onChange={async e=>{const file=e.target.files?.[0];if(!file)return;if(file.size>100000){notify('请选择 100KB 以内的文本文件');return}const text=await file.text();setDraft(d=>`${d}${d?'\n\n':''}文件：${file.name}\n\n${text}`);e.target.value='';textarea.current?.focus()}}/><span className="tool-divider"/><button className={`skills-button ${chat.skillId?'enabled':''}`} aria-label="选择技能" onClick={()=>setSkillsOpen(true)}><Sparkles size={16}/><span>技能</span></button><button className={`thinking-button ${thinking?'enabled':''}`} aria-pressed={thinking} onClick={()=>setThinking(!thinking)}><Brain size={16}/><span>深度思考</span>{thinking&&<Check size={12}/>}</button><button className="writing-button" onClick={()=>{setDraft(prompts[0].prompt);textarea.current?.focus()}}><PencilLine size={16}/><span>帮我写作</span></button></div><div className="composer-send"><span className="speed-label">{thinking?'深度':'快速'}<ChevronDown size={12}/></span>{busy?<button className="send-button stop" aria-label="停止生成" onClick={()=>void stopGeneration()}><Square size={15} fill="currentColor"/></button>:<button className="send-button" disabled={!draft.trim()} aria-label="发送" onClick={()=>void send()}><ArrowUp size={21}/></button>}</div></div></div><div className="composer-footer"><span>{running?(reconnecting.size?'连接恢复中 · 后台继续生成':'正在生成 · 刷新可自动恢复'):'内容由 AI 生成，请仔细甄别'}</span><span className={`history-sync ${saveStatus}`} role="status">{saveStatus==='loading'?'正在恢复记录…':saveStatus==='saving'?'正在保存…':saveStatus==='saved'?'已保存到本机服务':saveStatus==='local'?'仅存于浏览器 · 服务端备份待重试':'保存失败，请导出对话备份'}</span><span>Enter 发送 · Shift + Enter 换行</span></div></div>
    </main>
    {skillsOpen&&<SkillsDialog catalog={catalog} loading={skillsLoading} error={skillsError} selectedId={chat.skillId} onRefresh={()=>void loadSkills(true)} onUse={chooseSkill} onClear={clearSkill} onClose={()=>setSkillsOpen(false)}/>}
    {settings&&<SettingsDialog config={config} close={()=>setSettings(false)} saved={c=>{setConfig(c);setSettings(false);notify('模型配置已更新')}}/>}
    {search!==null&&<div className="modal-backdrop" onClick={()=>setSearch(null)}><section className="search-dialog" role="dialog" aria-modal="true" aria-label="搜索对话" onClick={e=>e.stopPropagation()}><div className="search-input"><Search size={20}/><input autoFocus placeholder="搜索你的对话…" value={search} onChange={e=>setSearch(e.target.value)}/><button className="icon-button" aria-label="关闭搜索" onClick={()=>setSearch(null)}><X size={18}/></button></div><div className="search-results">{chats.filter(c=>c.messages.length&&(c.title.includes(search)||c.messages.some(m=>m.content.toLowerCase().includes(search.toLowerCase())))).map(c=><button key={c.id} onClick={()=>selectChat(c.id)}><MessageCircle size={17}/><span>{c.title}<small>{c.messages.at(-1)?.content.slice(0,65)}</small></span><ChevronRight size={15}/></button>)}{!chats.some(c=>c.messages.length&&(c.title.includes(search)||c.messages.some(m=>m.content.toLowerCase().includes(search.toLowerCase()))))&&<p>没有找到相关对话</p>}</div></section></div>}
    {deleteId&&<div className="modal-backdrop" onClick={()=>setDeleteId(null)}><section className="confirm-dialog" role="dialog" aria-modal="true" aria-label="删除对话" onClick={e=>e.stopPropagation()}><Trash2 size={24}/><h2>删除这段对话？</h2><p>此操作会移除本机保存的对话记录。</p><div><button onClick={()=>setDeleteId(null)}>取消</button><button className="danger" onClick={()=>{setChats(prev=>{const next=prev.filter(c=>c.id!==deleteId);return next.length?next:[starter()]});setDeleteId(null)}}>删除</button></div></section></div>}
    {toast&&<div className="toast" role="status"><Check size={16}/>{toast}</div>}
  </div>
}
function SettingsDialog({config,close,saved}:{config:Config|null;close:()=>void;saved:(c:Config)=>void}){
  const [baseUrl,setBaseUrl]=useState(config?.baseUrl||'https://test-stark.apuscn.com/v1')
  const [model,setModel]=useState(config?.model||'deepseek-flash')
  const [key,setKey]=useState('');const [saving,setSaving]=useState(false);const [error,setError]=useState('')
  return <div className="modal-backdrop" onClick={close}><section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={e=>e.stopPropagation()}><div className="dialog-heading"><div className="settings-icon"><Zap size={21}/></div><button className="icon-button" aria-label="关闭设置" onClick={close}><X size={20}/></button></div><h2 id="settings-title">连接你的智能助手</h2><p>通过 TokenHub，接入 DeepSeek Flash</p><form onSubmit={async e=>{e.preventDefault();setSaving(true);setError('');try{const res=await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({baseUrl,model,apiKey:key})});const data=await res.json();if(!res.ok)throw new Error(data.error);saved(data)}catch(e){setError(e instanceof Error?e.message:'保存失败')}finally{setSaving(false)}}}><label>API Base URL<input required type="url" value={baseUrl} onChange={e=>setBaseUrl(e.target.value)} placeholder="https://your-gateway/v1"/></label><label>模型 ID<input required value={model} onChange={e=>setModel(e.target.value)} placeholder="deepseek-flash"/></label><label>API Key <span>{config?.configured?'已配置，留空保留现有 Key':'必填'}</span><input autoComplete="off" type="password" value={key} onChange={e=>setKey(e.target.value)} placeholder={config?.configured?'••••••••••••••••':'请输入网关 API Key'} required={!config?.configured}/></label><div className="settings-note"><Settings size={15}/><span>Key 仅保存在本地服务的内存中，重启后恢复 .env 配置，不写入浏览器存储。</span></div>{error&&<p className="form-error" role="alert">{error}</p>}<button className="save-button" disabled={saving}>{saving?<LoaderCircle size={17} className="spin"/>:<Zap size={16}/>}保存配置</button></form><div className="dialog-bottom">OpenAI 兼容协议 <span>·</span> 流式回复 <span>·</span> 深度思考</div></section></div>
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>)
