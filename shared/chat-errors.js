/** Turn transport errors into a recovery instruction without hiding other API errors. */
export function chatErrorMessage(error,hasPartial=false){
 const message=error instanceof Error?error.message:String(error||'网络异常，请重试')
 if(/network\s?error|failed to fetch|fetch failed|load failed|terminated|socket|ECONNRESET|UND_ERR_|连接提前中断|请求已停止或超时/i.test(message)){
  return hasPartial?'生成连接中断，已保留收到的内容。可点击「继续生成」接着写。':'模型服务连接失败或超时，请检查网络后重试。'
 }
 return message
}
