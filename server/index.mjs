import { createApp } from './app.mjs'
const port = Number(process.env.PORT || 3210)
const server = createApp({recoverRuns:true})
server.listen(port, '127.0.0.1', () => console.log(`DeepSeek Chat: http://127.0.0.1:${port}/chat`))
let closing=false
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, async () => {if(closing)return;closing=true;await server.shutdownRuns();server.closeAllConnections();server.close(() => process.exit(0))})
