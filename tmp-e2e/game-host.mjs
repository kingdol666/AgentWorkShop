// 游戏主持人:回答猜数字(秘密=42)与海龟汤的是非题
import { appendFileSync } from 'node:fs'

const B = 'http://localhost:3001'
const TOK = (await (await fetch(`${B}/api/users/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'visual@awshop.local', password: 'Visual2026' }),
})).json()).data?.token
const H = { 'authorization': `Bearer ${TOK}`, 'content-type': 'application/json' }
const CH = '28ab0e17-ac4d-4275-b76b-d068aa395f51'
const SECRET = 42
const log = (s) => {
  console.log(s)
  appendFileSync('tmp-e2e/game-host.log', s + '\n')
}

// 海龟汤判定规则(经典汤底:海难食尸,味道相同故知真相)
const soupJudge = (q) => {
  const has = (...ks) => ks.some(k => q.includes(k))
  if (has('海难', '沉船', '事故', '遇难')) return '是'
  if (has('人肉', '尸体', '同伴', '死去的', '吃了人', '同类', '肉')) return '是'
  if (has('味道', '尝出', '一样', '相同', '真正的海龟')) return '是'
  if (has('自杀', '愧疚', '知道真相')) return '是'
  if (has('餐厅', '服务员', '厨师', '点单')) return '无关'
  if (has('生病', '中毒', '过敏', '欠债', '仇人', '下毒')) return '不是'
  return '无关'
}
const seen = new Set()
const deadline = Date.now() + 40 * 60_000
log('=== 游戏主持人启动(秘密=42) ===')
while (Date.now() < deadline) {
  await new Promise(r => setTimeout(r, 10_000))
  try {
    const pend = await (await fetch(`${B}/api/workshop/hitl/pending?channelId=${CH}`, { headers: H })).json()
    for (const item of (pend.data?.items ?? [])) {
      if (item.kind === 'dcw-approval') continue
      const key = item.kind + ':' + item.id
      if (seen.has(key)) continue
      seen.add(key)
      const q = [item.title ?? '', item.detail ?? '', item.message ?? '', ...(item.questions ?? []).flatMap(x => [x.title ?? '', x.question ?? '', x.description ?? ''])].join(' ')
      log(`🙋 [${item.kind}] ${q.slice(0, 160).replace(/\n/g, ' ')}`)
      // 判定答复
      const numMatch = [...q.matchAll(/\b(\d{1,3})\b/g)].map(m => Number(m[1])).filter(n => n >= 1 && n <= 100)
      let answer
      if (numMatch.length > 0 && /猜|数字|大了|小了/.test(q)) {
        const g = numMatch[numMatch.length - 1]
        answer = g === SECRET ? '正确' : (g > SECRET ? '大了' : '小了')
        log(`   → 猜数字 ${g} → ${answer}`)
      }
      else {
        answer = soupJudge(q)
        log(`   → 海龟汤 → ${answer}`)
      }
      const body = item.questions && item.questions.length > 0
        ? { kind: item.kind, id: item.id, answers: item.questions.map((x, i) => ({ id: x.id, answer: i === 0 ? answer : answer })) }
        : { kind: item.kind, id: item.id, value: answer }
      const r = await (await fetch(`${B}/api/workshop/hitl/respond`, { method: 'POST', headers: H, body: JSON.stringify(body) })).json()
      log(`   ↩ respond code=${r.code} ${r.message ?? ''}`)
    }
  }
  catch (e) { log('poll err: ' + e.message) }
}
log('=== 主持人退出 ===')
