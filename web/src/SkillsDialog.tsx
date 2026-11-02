import { useEffect, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { BookOpen, Check, ChevronRight, FolderOpen, LoaderCircle, RefreshCw, Search, Sparkles, X } from 'lucide-react'

export type SkillSummary = { id:string; name:string; description:string; argumentHint:string; allowedTools:string[]; requirements:string[]; source:string; path:string }
export type SkillCatalog = { skills:SkillSummary[]; sources:{path:string;label:string;available:boolean}[]; warnings:string[] }
type SkillDetail = SkillSummary & {content:string}
export function SkillsDialog({catalog,loading,error,selectedId,onRefresh,onUse,onClear,onClose}:{catalog:SkillCatalog;loading:boolean;error:string;selectedId?:string;onRefresh:()=>void;onUse:(skill:SkillSummary)=>void;onClear:()=>void;onClose:()=>void}){
  const [query,setQuery]=useState('')
  const [previewId,setPreviewId]=useState(selectedId||catalog.skills[0]?.id||'')
  const [detail,setDetail]=useState<SkillDetail|null>(null)
  const [detailError,setDetailError]=useState('')
  const [detailLoading,setDetailLoading]=useState(false)
  const [sourcesOpen,setSourcesOpen]=useState(false)
  useEffect(()=>{if(!previewId&&catalog.skills[0])setPreviewId(catalog.skills[0].id)},[catalog,previewId])
  useEffect(()=>{
    if(!previewId)return
    const controller=new AbortController();setDetail(null);setDetailError('');setDetailLoading(true)
    fetch(`/api/skills/${encodeURIComponent(previewId)}`,{signal:controller.signal}).then(async res=>{const data=await res.json();if(!res.ok)throw new Error(data.error||'技能加载失败');return data}).then(setDetail).catch(e=>{if(!controller.signal.aborted)setDetailError(e.message)}).finally(()=>{if(!controller.signal.aborted)setDetailLoading(false)})
    return()=>controller.abort()
  },[previewId,catalog])
  const filtered=catalog.skills.filter(s=>`${s.name} ${s.description} ${s.source}`.toLowerCase().includes(query.toLowerCase()))
  return <div className="modal-backdrop" onClick={onClose}><section className="skills-dialog" role="dialog" aria-modal="true" aria-labelledby="skills-title" onClick={e=>e.stopPropagation()}>
    <header className="skills-heading"><div><span className="skills-logo"><Sparkles size={20}/></span><div><h2 id="skills-title">技能库 <span>{catalog.skills.length}</span></h2><p>选择本地技能，让对话更擅长你的任务</p></div></div><button className="icon-button" aria-label="关闭技能库" onClick={onClose}><X size={20}/></button></header>
    <div className="skills-layout"><div className="skills-library"><div className="skills-search"><Search size={16}/><input autoFocus value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索技能名称或用途…" aria-label="搜索技能"/><button className="icon-button" onClick={onRefresh} disabled={loading} aria-label="刷新技能列表"><RefreshCw size={15} className={loading?'spin':''}/></button></div>
      <div className="skills-list">{loading&&!catalog.skills.length?<div className="skills-empty"><LoaderCircle className="spin" size={22}/>正在读取本地技能…</div>:error?<div className="skills-empty form-error" role="alert">{error}<button onClick={onRefresh}>重试</button></div>:!filtered.length?<div className="skills-empty"><FolderOpen size={25}/>{catalog.skills.length?'没有找到匹配的技能':'还没有发现本地技能'}<span>{catalog.skills.length?'换个关键词试试':'可将技能放入项目 skills/名称/SKILL.md'}</span></div>:filtered.map(skill=><button key={skill.id} className={`skill-list-item ${skill.id===previewId?'previewed':''}`} onClick={()=>setPreviewId(skill.id)}><div><strong>{skill.name}</strong>{skill.id===selectedId&&<span className="skill-current"><Check size={10}/>已选</span>}</div><p>{skill.description}</p><span className="skill-source">{skill.source}</span><ChevronRight size={14}/></button>)}</div>
      <button className="skill-sources-toggle" onClick={()=>setSourcesOpen(!sourcesOpen)}><FolderOpen size={13}/>{sourcesOpen?'收起加载目录':'查看加载目录'}<span>{catalog.sources.filter(s=>s.available).length} 个</span></button>
    </div><div className="skill-preview">{detailLoading?<div className="skills-empty"><LoaderCircle size={22} className="spin"/>正在读取技能内容…</div>:detailError?<div className="skills-empty form-error" role="alert">{detailError}</div>:detail?<><div className="skill-preview-header"><span className="skill-preview-label"><BookOpen size={13}/>SKILL.md</span><h3>{detail.name}</h3><p>{detail.description}</p><code>/{detail.name}{detail.argumentHint?' '+detail.argumentHint:' 你的任务'}</code>{detail.requirements.length>0&&<div className="skill-requirements">声明的工具或运行要求：{detail.requirements.join('、')}。当前按文本指引运行，可读取技能内参考资料。</div>}</div><div className="skill-markdown message-content"><Markdown remarkPlugins={[remarkGfm]} components={{a:({children,href})=>href&&/^https?:\/\//.test(href)?<a href={href} target="_blank" rel="noopener noreferrer">{children}</a>:<span title={href}>{children}</span>}}>{detail.content}</Markdown></div></>:<div className="skills-empty"><Sparkles size={27}/>选择一个技能查看内容</div>}</div></div>
    {sourcesOpen&&<div className="skills-sources">{catalog.sources.map(s=><div key={s.path}><i className={s.available?'connected':''}/><strong>{s.label}</strong><code>{s.path}</code><span>{s.available?'已读取':'未创建'}</span></div>)}{catalog.warnings.map((w,i)=><p key={i}>{w}</p>)}</div>}
    <footer className="skills-footer"><p>支持技能指引与只读参考资料；不执行脚本、终端或 MCP。</p><div>{selectedId&&<button className="clear-skill" onClick={()=>{onClear();onClose()}}>取消当前技能</button>}<button className="use-skill" disabled={!detail||detailLoading||Boolean(detailError)} onClick={()=>{if(detail)onUse(detail)}}><Sparkles size={15}/>{detail?.id===selectedId?'继续使用':'在当前对话使用'}</button></div></footer>
  </section></div>
}
