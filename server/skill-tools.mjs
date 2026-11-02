export const skillTools = [{type:'function',function:{name:'read_skill_file',description:'读取当前用户选择的技能目录内的文本参考文件。仅支持相对路径，不执行脚本或命令。',parameters:{type:'object',properties:{path:{type:'string',description:'相对于当前技能目录的文本路径，例如 references/guide.md'}},required:['path'],additionalProperties:false}}}]

export function createToolAccumulator(){
  const calls=new Map()
  return {
    add(deltas){
      if(!Array.isArray(deltas))return
      for(const delta of deltas){
        if(!Number.isInteger(delta.index)||delta.index<0||delta.index>7)throw new Error('模型返回了过多或无效的工具调用')
        const call=calls.get(delta.index)||{id:'',type:'function',function:{name:'',arguments:''}}
        call.id+=delta.id||'';call.function.name+=delta.function?.name||'';call.function.arguments+=delta.function?.arguments||''
        if(call.function.arguments.length>8192||call.function.name.length>128||call.id.length>256)throw new Error('技能工具调用参数过长')
        calls.set(delta.index,call)
      }
    },
    finish(){return [...calls.entries()].sort(([a],[b])=>a-b).map(([,call])=>{if(!call.id||!call.function.name)throw new Error('技能工具调用数据不完整');return call})},
  }
}
export async function runSkillTool(call,skill,registry){
  try{
    if(call.function.name!=='read_skill_file')throw new Error('当前仅支持只读技能参考文件工具')
    const input=JSON.parse(call.function.arguments)
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>key!=='path'))throw new Error('工具参数无效')
    const result=await registry.readResource(skill,input.path)
    return {role:'tool',tool_call_id:call.id,content:JSON.stringify(result)}
  }catch(error){return {role:'tool',tool_call_id:call.id,content:JSON.stringify({error:error.message})}}
}
