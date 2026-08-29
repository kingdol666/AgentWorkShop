/** 产线控制策略终审:双产线并行独立控制 + 镜像数采打标 + 节点级独立 + 五维查询(含 nodeId 维) */
const TOKEN = 'ut-ffc1dfbbc0c1444c87c1ec69a9e8208c'
const ROOT = 'http://127.0.0.1:3000'
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const fail = (m) => { console.error('FAIL:', m); process.exitCode = 1 }
const jpost = (u, b) => fetch(ROOT + u, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) }).then(r => r.json())
const jget = (u) => fetch(ROOT + u, { headers: H }).then(r => r.json())
const jdel = (u) => fetch(ROOT + u, { method: 'DELETE', headers: H }).then(r => r.json())

const cleanup = []
async function main() {
  // ===== 双产线并行搭建(mock 驱动,聚焦控制策略) =====
  const mkLine = async (name) => {
    const line = (await jpost('/api/workshop/dcw/lines', { name })).data.line
    cleanup.push(['dcw-line', line.id])
    const prod = (await jpost('/api/workshop/dcw/products', { name: name + '产品', lineId: line.id })).data.product
    cleanup.push(['dcw-product', prod.id])
    const dq = (await jpost('/api/workshop/daq', { templateRef: 'daq-temp-tc', name: name + '-温度采集', intervalMs: 400, lineId: line.id })).data.node
    const dw = (await jpost('/api/workshop/dcw', { templateRef: 'dcw-temp-sp', name: name + '-温度设定', lineId: line.id })).data.node
    cleanup.push(['daq', dq.id], ['dcw', dw.id])
    const rc = (await jpost('/api/workshop/dcw/recipes', {
      productId: prod.id, name: name + '配方',
      params: [{ templateRef: 'dcw-temp-sp', nodeId: dw.id, value: name.includes('X') ? 180 : 165, min: 150, max: 200 }],
      daqWindows: [{ nodeId: dq.id, min: 100, max: 260 }],
    })).data.recipe
    cleanup.push(['dcw-recipe', rc.id])
    return { line, prod, dq, dw, rc }
  }
  const LX = await mkLine('控制终审X线')
  const LY = await mkLine('控制终审Y线')
  console.log('[场景] 双产线 X/Y 搭建完成(各 1 数采 + 1 数控)')

  // ===== 1. X 开跑,Y 不跑:采集严格隔离 =====
  await jpost(`/api/workshop/dcw/lines/${LX.line.id}/start`, { recipeId: LX.rc.id })
  await sleep(3000)
  let nodes = (await jget('/api/workshop/daq')).data.nodes
  const xLive = nodes.find(n => n.id === LX.dq.id)
  const yIdle = nodes.find(n => n.id === LY.dq.id)
  if (xLive?.value != null && xLive.state !== 'offline') console.log('PASS X 线开跑 → X 数采流动')
  else fail(`X 数采未流动: ${xLive?.value}/${xLive?.state}`)
  if (yIdle?.state === 'offline' || yIdle?.value == null) console.log('PASS Y 线未开跑 → Y 数采暂停(独立门控)')
  else fail(`Y 未开跑却在采样: ${yIdle?.value}`)

  // ===== 2. X 配方下发已执行(节点级参数),Y 节点未受影响 =====
  const dwX = (await jget('/api/workshop/dcw')).data.nodes.find(n => n.id === LX.dw.id)
  const dwY = (await jget('/api/workshop/dcw')).data.nodes.find(n => n.id === LY.dw.id)
  if (dwX?.value === 180) console.log('PASS X 配方参数下发(X 节点=180)')
  else fail(`X 节点值: ${dwX?.value}`)
  if (dwY?.value == null) console.log('PASS Y 节点未受 X 配方影响(独立)')
  else fail(`Y 节点被污染: ${dwY?.value}`)

  // ===== 3. Y 开跑 → 双线并行采集;X 停 → 仅 X 停 =====
  await jpost(`/api/workshop/dcw/lines/${LY.line.id}/start`, { recipeId: LY.rc.id })
  await sleep(2500)
  await jpost(`/api/workshop/dcw/lines/${LX.line.id}/stop`, {})
  await sleep(2000)
  nodes = (await jget('/api/workshop/daq')).data.nodes
  const xAfter = nodes.find(n => n.id === LX.dq.id)
  const yAfter = nodes.find(n => n.id === LY.dq.id)
  if (xAfter?.state === 'offline') console.log('PASS X 停 → 仅 X 节点 offline(逐线停采)')
  else fail(`X 停后状态: ${xAfter?.state}`)
  if (yAfter?.value != null && yAfter.state !== 'offline') console.log('PASS 双线并行:Y 继续采集不受 X 停影响')
  else fail(`Y 被误停: ${yAfter?.state}`)

  // ===== 4. 五维查询:lineId/nodeId/产品/配方/时间/聚合 =====
  const qs = (p) => new URLSearchParams(Object.entries(p).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)]))
  // 4.1 X 线窗口(停线后历史数据仍可查 —— 打标持久化)
  const qX = await jget(`/api/workshop/dcw/line/query?${qs({ lineId: LX.line.id, from: Date.now() - 600_000, to: Date.now(), bucketMs: 1000 })}`)
  const chX = qX.data?.channels?.find(c => c.nodeId === LX.dq.id)
  if ((chX?.points?.length ?? 0) > 3) console.log(`PASS 查询① lineId=X:历史打标数据 ${chX.points.length} 点(停线后仍可查)`)
  else fail(`X 历史查询空: ${chX?.points?.length}`)
  // 4.2 nodeId 维:查 Y 的节点只回 Y
  const qN = await jget(`/api/workshop/dcw/line/query?${qs({ nodeId: LY.dq.id, from: Date.now() - 600_000, to: Date.now() })}`)
  const chIds = (qN.data?.channels ?? []).map(c => c.nodeId)
  if (chIds.length === 1 && chIds[0] === LY.dq.id) console.log('PASS 查询② nodeId 维:精确单节点')
  else fail(`nodeId 过滤异常: ${chIds}`)
  // 4.3 产品隔离:Y 产品只能看到 Y 数据
  const qP = await jget(`/api/workshop/dcw/line/query?${qs({ productId: LY.prod.id, from: Date.now() - 600_000, to: Date.now(), bucketMs: 1000 })}`)
  const chP = (qP.data?.channels ?? []).map(c => c.nodeId)
  if (chP.includes(LY.dq.id) && !chP.includes(LX.dq.id)) console.log('PASS 查询③ 产品隔离:Y 产品仅见 Y 通道')
  else fail(`产品隔离失效: ${chP}`)
  // 4.4 配方维:X 配方查 X 数据
  const qR = await jget(`/api/workshop/dcw/line/query?${qs({ recipeId: LX.rc.id, from: Date.now() - 600_000, to: Date.now(), bucketMs: 1000 })}`)
  const chR = (qR.data?.channels ?? []).map(c => c.nodeId)
  if (chR.includes(LX.dq.id) && !chR.includes(LY.dq.id)) console.log('PASS 查询④ 配方维:X 配方仅见 X 采集')
  else fail(`配方维失效: ${chR}`)

  // ===== 5. 产线/节点/配方解绑与删除保护 =====
  // 运行中产线不可再 start(409)
  const again = await jpost(`/api/workshop/dcw/lines/${LY.line.id}/start`, { recipeId: LY.rc.id })
  if (again.code === 'CONFLICT') console.log('PASS 双开保护:运行中产线重复开跑 409')
  else fail(`双开未拦截: ${again.code}`)
  // 产品删除保护(运行中产线的产品)
  const delProd = await jdel(`/api/workshop/dcw/products/${LY.prod.id}`)
  if (delProd.code === 'CONFLICT') console.log('PASS 删除保护:运行中产线的产品不可删')
  else fail(`删除保护失效: ${delProd.code}`)
  // 停 Y 后可删
  await jpost(`/api/workshop/dcw/lines/${LY.line.id}/stop`, {})
  const delProd2 = await jdel(`/api/workshop/dcw/products/${LY.prod.id}`)
  if (!delProd2.code) console.log('PASS 停线后:产品可正常删除')
  else fail(`停线后删除异常: ${delProd2.code}`)
}

main()
  .then(async () => {
    for (const [kind, id] of [...cleanup].reverse()) {
      try {
        if (kind === 'dcw-line') await jpost(`/api/workshop/dcw/lines/${id}/stop`, {}).catch(() => {})
        else if (kind === 'daq') await jdel(`/api/workshop/daq/${id}`)
        else if (kind === 'dcw') await jdel(`/api/workshop/dcw/${id}`)
        else if (kind === 'dcw-recipe') await jdel(`/api/workshop/dcw/recipes/${id}`)
        else if (kind === 'dcw-product') await jdel(`/api/workshop/dcw/products/${id}`)
      }
      catch { /* 尽力 */ }
    }
    console.log(process.exitCode ? 'E2E-C FAILED' : 'E2E-C ALL PASS')
    process.exit(process.exitCode ?? 0)
  })
  .catch((err) => { console.error('FATAL:', err.message); process.exit(1) })
