// 全库 v4 会话扫描 v2:zstd CLI 精确解压(支持多帧)+ 毒记录统计
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const S = 'C:/Users/87287/.dsh/sessions'
const ZSTD = 'D:/ProgramData/anaconda3/Library/bin/zstd.exe'
function decompress(f) {
  return execFileSync(ZSTD, ['-d', '-c', f], { maxBuffer: 512 * 1024 * 1024 }).toString('utf8')
}
let poisoned = []
let totalSessions = 0
for (const proj of fs.readdirSync(S)) {
  const pd = path.join(S, proj)
  for (const sid of fs.readdirSync(pd)) {
    const f = path.join(pd, sid, 'session.v4.jsonl.zstd')
    if (!fs.existsSync(f)) continue
    totalSessions++
    try {
      const lines = decompress(f).trim().split('\n')
      let bad = 0
      let total = 0
      for (const l of lines) {
        try {
          const j = JSON.parse(l)
          total++
          if (j.kind === 'plugin') bad++
        }
        catch { bad++ }
      }
      if (bad > 0) poisoned.push({ proj, sid, bad, total })
      console.log(proj.slice(0, 30), sid.slice(0, 8), '| 记录', total, '| 毒记录', bad)
    }
    catch (e) {
      console.log(proj.slice(0, 30), sid.slice(0, 8), '| 异常:', e.message.slice(0, 60))
    }
  }
}
console.log(totalSessions ? (poisoned.length ? `毒会话 ${poisoned.length} 个` : `全部 ${totalSessions} 会话零毒记录`) : '无会话')
