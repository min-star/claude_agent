/** Parse SSE across arbitrary UTF-8/CRLF chunk boundaries. */
export async function* readSSE(stream, onActivity = () => {}) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let data = []
  try {
    while (true) {
      const { value, done } = await reader.read()
      onActivity()
      buffer += decoder.decode(value, { stream: !done })
      if (done && buffer && !buffer.endsWith('\n')) buffer += '\n'
      let end
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end).replace(/\r$/, '')
        buffer = buffer.slice(end + 1)
        if (line === '') {
          if (data.length) yield data.join('\n')
          data = []
        } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      }
      if (done) { if (data.length) yield data.join('\n'); break }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
