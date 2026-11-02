import { spawn } from 'node:child_process'
import './index.mjs'
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'web/vite.config.ts'], {stdio:'inherit'})
vite.on('exit', code => process.exit(code || 0))
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => vite.kill(signal))
