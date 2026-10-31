#!/usr/bin/env node
/**
 * kill-acceptance-strays.mjs —— 验收残留清场:按命令行特征杀 node 进程,并释放指定端口。
 * 用法:node scripts/_audit/kill-acceptance-strays.mjs <port> <特征1> [特征2...]
 * 特征匹配 PowerShell Win32_Process.CommandLine 正则;杀整树(taskkill /T /F)。
 */
import { execSync } from 'node:child_process'

const port = process.argv[2] ?? '3300'
const patterns = process.argv.slice(3)
const ps = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`
let out = ''
try {
  out = execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { encoding: 'utf8', timeout: 30_000 })
}
catch (e) {
  console.error('枚举失败:', e.message?.slice(0, 200))
  process.exit(1)
}
const procs = out.trim() ? JSON.parse(out) : []
const list = Array.isArray(procs) ? procs : [procs]
let killed = 0
for (const p of list) {
  const cl = String(p.CommandLine ?? '')
  if (patterns.some(pat => cl.includes(pat))) {
    try {
      execSync(`taskkill /PID ${p.ProcessId} /T /F`, { stdio: 'ignore' })
      console.log('killed', p.ProcessId, cl.slice(0, 100))
      killed++
    }
    catch { /* 已退出 */ }
  }
}
// 端口属主兜底
try {
  const net = execSync('netstat -ano', { encoding: 'utf8' })
  for (const pid of [...new Set(net.split('\n').filter(l => l.includes(`:${port} `) && l.toUpperCase().includes('LISTENING')).map(l => l.trim().split(/\s+/).at(-1)))]) {
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' })
      console.log('killed port-owner', pid)
      killed++
    }
    catch { /* 已退出 */ }
  }
}
catch { /* netstat 失败忽略 */ }
console.log(`killed=${killed}`)
