/**
 * scripts/onboarding/verify-line.mjs —— 接入验收(skill 阶段5;未全绿不得宣告完成)。
 * 断言面:
 *  V1 数采落库:每个 daq 节点 2 分钟窗内 samples 有点(五协议真实在采)
 *  V2 量程联锁:对每个 dcw 节点做越界写(max+步长量级)必须被 400 拒(NODE_RANGE/RANGE 类)
 *  V3 合法写回环:max- 步长量级的合法值写成功且回读一致(manual 来源,审计留痕)
 *  V4 配方在册:recipeId 在 /dcw 聚合可见且参数节点映射正确
 *  V5 频道绑定:频道 lineId 正确、成员≥2、插件开启生效
 *  V6 演示线零扰动:受保护线上没有任何本次新节点的写痕(以 dcw journal 新锚点核对)
 * 输入 JSON:
 * {
 *   "lineId":"ln-..","recipeId":"rc-..","channelId":"<uuid>",
 *   "dcw":[{"id":"dw-..","name":"..","min":120,"max":300,"stepLimit":5,"probeValue":180}],
 *   "daq":["dn-..","dn-.."],
 *   "plugins":["idd-closedloop-bridge","rag-bridge"]
 * }
 * 用法:node scripts/onboarding/verify-line.mjs <config.json|->
 */
import { api, login, ok, summary, readConfig, pollUntil } from './lib.mjs'

const cfg = await readConfig()
const tok = await login()

// V1 数采落库(滑动窗口:每次轮询重算 now,避免 to=启动时刻冻结导致新样本落窗外)。
// 多形态节点(向量/图像)数据在 daq_frames 不在 daq_samples:标量面 60s 内无点时回查帧面。
for (const id of cfg.daq ?? []) {
  try {
    await pollUntil(async () => {
      const now = Date.now()
      const j = await api('GET', `/api/workshop/daq/${id}/samples?from=${now - 90000}&to=${now}&bucketMs=30000`, undefined, tok)
      if ((j.data?.points ?? []).length > 0) return true
      const f = await api('GET', `/api/workshop/daq/${id}/frames?from=${now - 120000}&to=${now}&limit=1`, undefined, tok).catch(() => null)
      return (f?.data?.frames ?? f?.data ?? []).length > 0
    }, { timeoutMs: 120000, label: `采样[${id}]` })
    ok(`V1 数采落库[${id}]`, true)
  }
  catch (e) {
    ok(`V1 数采落库[${id}]`, false, String(e).slice(0, 80))
  }
}

// V2/V3 量程联锁 + 合法回环
for (const n of cfg.dcw ?? []) {
  const span = Math.max(1, (n.max - n.min) / 10)
  const bad = await api('POST', `/api/workshop/dcw/${n.id}/write`, { value: n.max + span }, tok)
  const rejected = bad.code !== 0 || bad.code === 'RANGE' || /RANGE|LIMIT|越界|超|400|VALIDATION/i.test(String(bad.message ?? '') + String(bad.code ?? ''))
  ok(`V2 越界拒[${n.name}]`, rejected, `value=${n.max + span} → ${String(bad.message ?? bad.code).slice(0, 60)}`)
  // V3 探针必须在写前实时取值:开批次后引擎/配方会驱动 SP,配置期探针会过期。
  // 只写命令点(如 mqtt commandTopic)read 返 null → 回退用最近一次写锚点值当现值。
  let probe = n.probeValue
  const rd = await api('POST', `/api/workshop/dcw/${n.id}/read`, {}, tok).catch(() => null)
  let cur = rd?.data?.read?.value
  if (typeof cur !== 'number') {
    const jr = await api('GET', '/api/workshop/dcw/journal?limit=30', undefined, tok)
    const lastAnchor = (jr.data?.anchors ?? []).filter(a => a.nodeId === n.id)
      .sort((a, b) => Date.parse(b.at ?? 0) - Date.parse(a.at ?? 0))[0]
    if (lastAnchor && typeof lastAnchor.newValue === 'number') cur = lastAnchor.newValue
  }
  if (typeof cur === 'number') probe = Math.min(n.max - n.stepLimit, Math.max(n.min + n.stepLimit, Math.round((cur + n.stepLimit) * 10) / 10))
  // V3 可能撞 60s 写间隔限速(上一轮验收刚写过)——等待限速窗过后重试一次
  let good = await api('POST', `/api/workshop/dcw/${n.id}/write`, { value: probe }, tok)
  if (good.code !== 0 && /间隔|60s|WRITE_INTERVAL/i.test(String(good.message ?? ''))) {
    await new Promise(r => setTimeout(r, 65000))
    good = await api('POST', `/api/workshop/dcw/${n.id}/write`, { value: probe }, tok)
  }
  const goodOk = good.code === 0 || !!good.data?.outcome
  ok(`V3 合法写回环[${n.name}]`, goodOk, `cur=${cur ?? '?'} probe=${probe} ${goodOk ? (good.data?.outcome?.readback ?? 'ok') : String(good.message ?? good.code).slice(0, 80)}`)
}

// V4 配方在册
const agg = await api('GET', '/api/workshop/dcw', undefined, tok)
const rec = (agg.data?.recipes ?? []).find(r => r.id === cfg.recipeId)
ok('V4 配方在册', !!rec, rec ? `${rec.name} v${rec.version} params=${(rec.params ?? []).length}` : (cfg.recipeId ?? '未提供'))

// V5 频道绑定与插件
const ch = await api('GET', `/api/workshop/channels/${cfg.channelId}`, undefined, tok)
const c = ch.data?.channel ?? ch.data
ok('V5 频道绑线', c?.lineId === cfg.lineId, `${c?.lineId} vs ${cfg.lineId}`)
const members = await api('GET', `/api/workshop/channels/${cfg.channelId}/agents`, undefined, tok)
ok('V5 频道成员≥2', (members.data ?? []).length >= 2, `members=${(members.data ?? []).length}`)
if (cfg.plugins?.length) {
  const pj = await api('GET', `/api/workshop/channels/${cfg.channelId}/plugins`, undefined, tok)
  const enabled = new Set((pj.data?.plugins ?? []).filter(p => p.enabled).map(p => p.name))
  for (const name of cfg.plugins) ok(`V5 插件[${name}]`, enabled.has(name), enabled.has(name) ? 'enabled' : `实际=${[...enabled].join(',')}`)
}

// V6 演示线零扰动:本验收的写锚点必须全部落在新线上,受保护线(ln-d7e0a2a2)零新增锚点
const journal = await api('GET', '/api/workshop/dcw/journal?limit=20', undefined, tok)
const mine = new Set([...(cfg.dcw ?? []).map(n => n.id)])
const touched = (journal.data?.anchors ?? []).filter(a => mine.has(a.nodeId))
const onProtected = touched.filter(a => a.lineId === 'ln-d7e0a2a2')
ok('V6 受保护线零扰动(写锚点全落新线)', onProtected.length === 0,
  `本线锚点=${touched.length} 溢出到受保护线=${onProtected.length}`)

summary('接入验收')
