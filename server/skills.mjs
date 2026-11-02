import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { parseDocument } from 'yaml'

const MAX_BYTES = 96 * 1024
const error = (message, status = 400) => Object.assign(new Error(message), { status })
const within = (root, file) => file.startsWith(root + path.sep)
export function defaultSkillSources(root, env = process.env) {
  return [
    { path: path.join(root, '.claude/skills'), label: '项目 · Claude' },
    { path: path.join(root, '.agents/skills'), label: '项目 · Agents' },
    { path: path.join(root, 'skills'), label: '项目' },
    { path: path.join(homedir(), '.claude/skills'), label: '个人 · Claude' },
    { path: path.join(homedir(), '.codex/skills'), label: '个人 · Codex' },
    { path: path.join(homedir(), '.agents/skills'), label: '个人 · Agents' },
    ...(env.SKILL_DIRS || '').split(path.delimiter).filter(Boolean).map(p => ({path: path.resolve(p), label: '自定义'})),
  ]
}
export function parseSkill(text, fallbackName) {
  text = text.replace(/^\uFEFF/, '')
  let metadata = {}, content = text
  if (/^---\r?\n/.test(text)) {
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
    if (!match) throw error('SKILL.md 的 YAML 头部没有结束标记')
    const doc = parseDocument(match[1], { uniqueKeys: true })
    if (doc.errors.length) throw error('SKILL.md 的 YAML 头部格式错误')
    metadata = doc.toJS({maxAliasCount: 20}) || {}
    if (typeof metadata !== 'object' || Array.isArray(metadata)) throw error('技能元数据必须是对象')
    content = text.slice(match[0].length)
  }
  if (!content.trim()) throw error('SKILL.md 正文为空')
  const name = String(metadata.name || fallbackName).trim()
  if (!name || name.length > 120 || /[\r\n\x00]/.test(name)) throw error('技能名称无效')
  const declared = metadata['allowed-tools']
  const allowedTools = Array.isArray(declared) ? declared.map(String) : typeof declared === 'string' ? [declared] : []
  return {
    name,
    description: String(metadata.description || content.split('\n').find(line => line.trim() && !line.startsWith('#')) || '本地技能').trim().slice(0, 2000),
    argumentHint: String(metadata['argument-hint'] || ''),
    userInvocable: metadata['user-invocable'] !== false && metadata['user-invocable'] !== 'false',
    allowedTools,
    requirements: [
      ...allowedTools.filter(tool => !/^(Read|read_skill_file)(\(|\s|$)/i.test(tool)),
      ...(metadata.context === 'fork' ? ['独立子任务'] : []),
      ...(metadata.hooks ? ['Hooks'] : []),
      ...(metadata.shell ? ['Shell'] : []),
      ...(/^!`/m.test(content) ? ['动态命令'] : []),
    ],
    content: content.trim(),
  }
}
async function readText(file, max = MAX_BYTES) {
  const info = await stat(file)
  if (!info.isFile() || info.size > max) throw error(`技能文件须为 ${Math.floor(max / 1024)}KB 以内的文本`)
  const buffer = await readFile(file)
  if (buffer.length > max || buffer.includes(0)) throw error('不支持该文件大小或二进制文件')
  return buffer.toString('utf8')
}
function publicSkill(skill) {
  const {content, directory, filename, userInvocable, ...metadata} = skill
  return metadata
}
export function createSkillRegistry(sources) {
  let catalog = null
  let timestamp = 0
  let inflight = null
  async function scan(refresh = false) {
    if (!refresh && catalog && Date.now() - timestamp < 10000) return catalog
    if (inflight) return inflight
    inflight = (async () => {
      const skills = [], warnings = [], roots = [], seen = new Set()
      for (const source of sources) {
        let entries
        try { entries = await readdir(source.path, { withFileTypes: true }); roots.push({...source, available:true}) }
        catch (e) { roots.push({...source, available:false}); if(e.code !== 'ENOENT') warnings.push(`${source.label}：无法读取技能目录`); continue }
        for (const entry of entries.slice(0, 500).sort((a,b)=>a.name.localeCompare(b.name))) {
          if (entry.name.startsWith('.') || !(entry.isDirectory() || entry.isSymbolicLink())) continue
          let filename
          try {
            const directory = await realpath(path.join(source.path, entry.name))
            if (seen.has(directory)) continue
            filename = await realpath(path.join(directory, 'SKILL.md'))
            if (!within(directory,filename)) throw error('SKILL.md 不得指向技能目录外')
            const skill = parseSkill(await readText(filename), entry.name)
            seen.add(directory)
            if (!skill.userInvocable) continue
            skills.push({...skill, id:createHash('sha256').update(directory).digest('hex').slice(0,24), source:source.label, path:filename, directory, filename})
          } catch(e) { if(e.code !== 'ENOENT') warnings.push(`${source.label}/${entry.name}：${e.status ? e.message : '技能文件无法加载'}`) }
        }
      }
      catalog = {skills, sources:roots, warnings}; timestamp=Date.now();return catalog
    })()
    try { return await inflight } finally { inflight=null }
  }
  async function get(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id)) throw error('无效的技能 ID',404)
    let skill = (await scan()).skills.find(s=>s.id===id)
    if (!skill) skill=(await scan(true)).skills.find(s=>s.id===id)
    if (!skill) throw error('技能不存在或不可手动调用，请刷新技能列表',404)
    try {
      const filename=await realpath(skill.filename)
      if (!within(skill.directory,filename)) throw error('技能路径已变更，请刷新列表')
      const parsed=parseSkill(await readText(filename),skill.name)
      if (!parsed.userInvocable) throw error('该技能已禁止手动调用')
      return {...skill,...parsed}
    } catch(e) { if(e.status) throw e; throw error('技能文件已移除或无法读取，请刷新列表',404) }
  }
  return {
    async list(refresh=false){const data=await scan(refresh);return {...data,skills:data.skills.map(publicSkill)}},
    get,
    async detail(id){const skill=await get(id);return {...publicSkill(skill),content:skill.content}},
    async readResource(skill, relative) {
      if (typeof relative !== 'string' || !relative || relative.length > 300 || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(s=>s==='..'||(s.startsWith('.')&&s!=='.')) || !/\.(md|txt|json|ya?ml|csv|tsv|html|css|js|mjs|ts|tsx|py|sh)$/i.test(relative)) throw error('仅能读取当前技能目录内的非隐藏文本文件，请使用相对路径')
      const target=path.resolve(skill.directory,relative)
      if (!within(skill.directory,target)) throw error('参考文件超出当前技能目录')
      let resolved
      try { resolved=await realpath(target) } catch { throw error('技能参考文件不存在',404) }
      if (!within(skill.directory,resolved)) throw error('参考文件不能链接到技能目录外')
      return {path:relative,content:await readText(resolved,48*1024)}
    },
  }
}
export function skillSystemMessage(skill, args='') {
  const expanded=skill.content.replace(/\$ARGUMENTS\b/g,()=>args).replace(/\$\{CLAUDE_SKILL_DIR\}|\$SKILL_DIR\b/g,()=>'.')
  if (expanded.length > 400000) throw error('技能与输入内容过长，请缩短请求')
  return {role:'system',content:`用户已手动选择技能：${skill.name}。请按以下技能指引处理用户请求。技能中的命令、脚本、工具名称均不代表已经执行。当前宿主仅支持文本回答，以及用 read_skill_file 读取该技能目录内的文本参考资料；不支持终端执行、写入文件、网络浏览、MCP、子代理和外部服务操作。不要声称执行了不可用操作；需要这些能力时提供可用文本并说明缺少的执行能力。技能提及相对链接时，使用 read_skill_file(path) 读取真实资料；只按需读取，不猜测内容。禁止输出 API Key 等凭据。\n\n<selected_skill name=${JSON.stringify(skill.name)}>\n${expanded}\n</selected_skill>`}
}
