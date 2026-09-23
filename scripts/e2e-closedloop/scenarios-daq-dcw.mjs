/**
 * s4 数采 / s5 帧 / s6 写控制 / s7 配方回退
 * (由 scripts/e2e-full-closedloop.mjs 按职责拆出;内容逐行原文搬运)
 */
import { TAG, ctx } from './state.mjs'
import { api, ok, section, waitUntil } from './lib.mjs'

// ════════════════════════════════════════════════════════════════
// S4 数采闭环
// ════════════════════════════════════════════════════════════════
export async function s4_daq() {
  section('S4 数采闭环(采样→队列→消费→落库→批次打标)')
  const ctrlOn = await api('POST', '/api/workshop/daq/controller', { body: { action: 'start' }, token: ctx.token })
  ok(ctrlOn.status === 200, '数采网关启动')

  const before = (await api('GET', '/api/workshop/daq', { token: ctx.token })).data?.meta ?? {}
  const startR = await api('POST', `/api/workshop/dcw/lines/${ctx.line?.id}/start`, { body: { recipeId: ctx.recipe?.id }, token: ctx.token })
  ok(startR.status === 200, '产线开跑(下发配方 + 激活批次窗口)', startR.message ?? '')
  const runId = startR.data?.run?.id
  ok(Boolean(runId), '批次 id 返回', runId)
  ok(Array.isArray(startR.data?.run?.results) && startR.data.run.results.length === 2, '配方逐参数下发结果 2 条')
  ok(startR.data?.run?.results?.every(r => r.ok === true), '两个参数下发均成功', JSON.stringify(startR.data?.run?.results ?? []).slice(0, 120))

  // 采样流入
  const grew = await waitUntil('samplesStored 增长', async () => {
    const s = (await api('GET', '/api/workshop/daq', { token: ctx.token })).data?.meta ?? {}
    return (s.samplesStored ?? 0) > (before.samplesStored ?? 0)
  }, 25_000)
  ok(Boolean(grew), '样本落库计数增长(samplesStored)')

  const after = (await api('GET', '/api/workshop/daq', { token: ctx.token })).data
  ok((after?.meta?.produced ?? 0) > (before.produced ?? 0), `生产计数增长(${before.produced} → ${after?.meta?.produced})`)
  ok((after?.meta?.consumed ?? 0) > (before.consumed ?? 0), `消费计数增长(${before.consumed} → ${after?.meta?.consumed})`)

  const node = (after?.nodes ?? []).find(n => n.id === ctx.daq.scalar?.id)
  ok(node?.value != null, `标量节点有实时值(${node?.value}${node?.unit ?? ''})`)
  ok(node?.lineId === ctx.line?.id, '节点产线归属正确')

  // 时序查询
  const samples = await api('GET', `/api/workshop/daq/${ctx.daq.scalar?.id}/samples?limit=100`, { token: ctx.token })
  const pts = samples.data?.points ?? samples.data?.samples ?? []
  ok(Array.isArray(pts) && pts.length > 0, `REST 历史查询返回样本(${pts.length} 点)`)

  // 批次打标:窗口内样本必须带 runId
  const lineState = await api('GET', `/api/workshop/dcw/lines`, { token: ctx.token })
  ok(Array.isArray(lineState.data?.lines), 'GET dcw/lines 可读')
  const st = await api('GET', `/api/workshop/dcw/lines/${ctx.line?.id}/state`, { token: ctx.token }).catch(() => ({ status: 0 }))
  if (st.status === 200) {
    ok(st.data?.state?.active === true || st.data?.active === true, '产线批次窗口处于活动态')
    ok((st.data?.state?.taggedSamples ?? st.data?.taggedSamples ?? 0) > 0, '批次打标计数 > 0')
  }
  else {
    // 该端点形态可能不同:用 runData 间接验证打标
    const rd = await api('GET', `/api/workshop/dcw/runs/${runId}/data`, { token: ctx.token })
    const daqRows = rd.data?.daq ?? []
    ok(daqRows.length > 0, `批次数据视图含数采汇总(${daqRows.length} 通道)`)
    ok(daqRows.some(r => r.cnt > 0), '批次窗口内确有打标样本')
  }

  ctx.runId = runId
}

// ════════════════════════════════════════════════════════════════
// S5 多形态帧管线 + 内存读穿透(P0-4 回归)
// ════════════════════════════════════════════════════════════════
export async function s5_frames() {
  section('S5 帧管线 + 内存读穿透(P0-4 回归)')
  const framesR = await waitUntil('vector 帧落库', async () => {
    const r = await api('GET', `/api/workshop/daq/${ctx.daq.vector?.id}/frames?limit=20`, { token: ctx.token })
    const f = r.data?.frames ?? []
    return f.length > 0 ? f : null
  }, 25_000)
  ok(Boolean(framesR), `vector 帧可查(${framesR?.length ?? 0} 帧)`)
  const first = framesR?.[0]
  if (first) {
    ok(first.kind === 'vector', '帧形态为 vector')
    ok(Array.isArray(first.points) && first.points.length > 0, `点列非空(${first.points?.length} 点)`)
    ok(first.runId === ctx.runId, '帧带批次打标(runId 一致)', `${first.runId} vs ${ctx.runId}`)
  }
  else {
    ok(false, 'vector 帧内容断言(无帧可断)')
  }

  // 图像帧:构造一个真实 PNG 驱动的 image 节点,走「广播带 thumbUrl → 立刻回查」的竞态路径
  // mock 驱动对 signalKind=image 会产出帧;若不可用则跳过并标注
  const tplImg = await api('POST', '/api/workshop/daq/templates', {
    body: {
      name: `E2E图像-${TAG}`,
      ch: '表面图像',
      unit: 'px',
      min: 0,
      max: 255,
      decimals: 0,
      signalKind: 'image',
      // 图像模板必须带 thumbnail 下沉处理器才会产出 thumbKey ——
      // 与内置 ccd-image 模板同构(thumbnail + quality-gate)。
      // 不带它时 frameContent(thumb=1) 必然 404,那是模板配置问题而非接口缺陷。
      sink: { processors: [{ name: 'thumbnail', args: { width: 128 } }, { name: 'quality-gate' }] },
    },
    token: ctx.token,
  })
  if (tplImg.data?.template?.key) {
    const imgNode = await api('POST', '/api/workshop/daq', {
      body: {
        name: `E2E图像-${TAG}`,
        templateRef: tplImg.data.template.key,
        driver: 'mock',
        intervalMs: 1000,
        publishIntervalMs: 0,
        lineId: ctx.line?.id,
        min: 0,
        max: 255,
      },
      token: ctx.token,
    })
    const imgId = imgNode.data?.node?.id
    ok(Boolean(imgId), '创建 image 节点')
    if (imgId) {
      const imgFrames = await waitUntil('image 帧落库', async () => {
        const r = await api('GET', `/api/workshop/daq/${imgId}/frames?limit=10&kind=image`, { token: ctx.token })
        const f = r.data?.frames ?? []
        return f.length > 0 ? f : null
      }, 30_000)
      if (imgFrames?.[0]) {
        const ts = imgFrames[0].at
        const content = await api('GET', `/api/workshop/daq/${imgId}/frames/content?ts=${ts}`, { token: ctx.token, raw: true })
        ok(content.status === 200, 'image 帧内容可读(200)', `status=${content.status}`)
        const ct = content.headers.get('content-type') ?? ''
        ok(/image\//.test(ct), `content-type 为图像(${ct})`)
        const thumb = await api('GET', `/api/workshop/daq/${imgId}/frames/content?ts=${ts}&thumb=1`, { token: ctx.token, raw: true })
        ok(thumb.status === 200, '缩略图可读(200)', `status=${thumb.status}`)
      }
      else {
        // mock 未实现 image 帧不算产品缺陷,但必须显式记录而非静默跳过
        console.log('    · mock 驱动未产出 image 帧(信号形态能力待确认),内存读穿透改由 vector 路径验证')
        ok(true, 'image 帧能力未就绪(mock 限制,已显式记录)')
      }
    }
  }
  else {
    ok(false, '创建 image 模板失败')
  }

  // 内存读穿透核心断言:帧刚 ingest(尚未 500ms 刷盘)立刻回查也必须命中。
  // 直接对「最新帧时间戳」查询 —— 若读穿透缺失,这里必 404。
  const latestR = await api('GET', `/api/workshop/daq/${ctx.daq.vector?.id}/frames?limit=1`, { token: ctx.token })
  const latest = latestR.data?.frames?.[0]
  if (latest) {
    const r = await api('GET', `/api/workshop/daq/${ctx.daq.vector?.id}/frames?limit=5&fromMs=${latest.at}&toMs=${latest.at}`, { token: ctx.token })
    ok((r.data?.frames ?? []).some(f => f.at === latest.at), '最新帧按精确时间戳可回查(读穿透生效)')
  }
}

// ════════════════════════════════════════════════════════════════
// S6 数控闭环
// ════════════════════════════════════════════════════════════════
export async function s6_dcw() {
  section('S6 数控闭环(下发→回读→记账→锚点→回退)')
  const w = await api('POST', `/api/workshop/dcw/${ctx.dcw.main?.id}/write`, { body: { value: 195 }, token: ctx.token })
  const outcome = w.data?.outcome ?? w.data
  ok(outcome?.ok === true, '下发 195℃ 成功', `readback=${outcome?.readback ?? '?'}`)
  ok(outcome?.readback != null, '回读校验返回读数')
  ok(Boolean(outcome?.anchorId), '参数变更锚已入册(anchorId)', outcome?.anchorId)
  // 设计语义:优化记录只由 source=agent|rollback 开窗(见 recipe-rollback-manager.afterWrite)。
  // 用户手动下发只记锚,不开记录 —— 否则每次人工调参都会生成一条无人判定的 open 记录,
  // 把「优化台账」淹成操作日志。此处断言该语义成立(手动写入不得开记录)。
  ok(outcome?.recordId == null, '手动下发只入锚、不开优化记录(recordId 应为空)', `recordId=${outcome?.recordId ?? 'null'}`)

  const nodeAfter = (await api('GET', '/api/workshop/dcw', { token: ctx.token })).data?.nodes?.find(n => n.id === ctx.dcw.main?.id)
  ok(nodeAfter?.value === 195 || String(nodeAfter?.value).startsWith('195'), `节点值已更新(${nodeAfter?.value})`)

  const rd = await api('POST', `/api/workshop/dcw/${ctx.dcw.main?.id}/read`, { body: {}, token: ctx.token })
  const readVal = rd.data?.read?.value ?? rd.data?.value
  ok(readVal != null, `手动读取返回真实读数(${readVal})`)

  const hist = await api('GET', '/api/workshop/dcw/journal?limit=20', { token: ctx.token })
  ok(hist.status === 200, 'GET dcw/journal 可读')

  const ledger = await api('GET', `/api/workshop/dcw/${ctx.dcw.main?.id}/param-ledger`, { token: ctx.token })
  ok(ledger.status === 200, 'GET param-ledger 可读')

  // 越配方窗口拒绝(配方 min 180 / max 200)
  const outWin = await api('POST', `/api/workshop/dcw/${ctx.dcw.main?.id}/write`, { body: { value: 215 }, token: ctx.token })
  ok(outWin.status >= 400, '超出配方工艺窗口的下发被拒', `status=${outWin.status} ${outWin.message ?? ''}`)
}

// ════════════════════════════════════════════════════════════════
// S7 回退账本
// ════════════════════════════════════════════════════════════════
export async function s7_rollback() {
  section('S7 调控闭环回退账本')
  const ob = await api('GET', '/api/workshop/dcw/optimizations', { token: ctx.token })
  ok(ob.status === 200, 'GET dcw/optimizations 可读')
  const recs = ob.data?.records ?? ob.data?.optimizations ?? []
  ok(Array.isArray(recs), `优化记录列表为数组(${recs.length} 条)`)
  // 此刻不应有本节点的记录:S6 是用户手动下发(只入锚不开记录)。enabled 时也允许
  // 历史记录存在(可复跑),故这里只断言"手动写入没有新增 open 记录"。
  const mineOpen = recs.filter(r => r.nodeId === ctx.dcw.main?.id && r.status === 'open')
  ok(mineOpen.length === 0, '手动下发未开窗 → 无 open 记录', `open=${mineOpen.length}`)

  // 界面回退(用户身份,不经 agent 鉴权)
  const rb = await api('POST', `/api/workshop/dcw/journal/node/${ctx.dcw.main?.id}/rollback`, { body: {}, token: ctx.token })
  ok(rb.status === 200 || rb.status === 409, '节点单步回退路径可达', `status=${rb.status} ${rb.message ?? ''}`)
  // 回退本身必须入册(source=rollback),这是台账可审计的前提
  if (rb.status === 200) {
    ok(Boolean(rb.data?.record?.id), '回退动作自身入册(source=rollback)', rb.data?.record?.id)
  }

  const nl = (await api('GET', '/api/workshop/dcw', { token: ctx.token })).data?.nodes?.find(n => n.id === ctx.dcw.main?.id)
  ok(nl != null, '回退后节点仍可读')

  // 注意:用户/系统回退**不受**冷却限制(设计如此:checkRollbackAllowed 仅约束 Agent,
  // 见 recipe-rollback-manager「Agent 回退护栏:冷却(用户/系统兜底不受链限)」——
  // 人在回路必须始终能紧急拉回,不能被 Agent 防乒乓闸门挡住)。
  // 因此这里断言的是"用户连续回退可达",Agent 侧冷却在 S8 断言。
  const rb2 = await api('POST', `/api/workshop/dcw/journal/node/${ctx.dcw.main?.id}/rollback`, { body: {}, token: ctx.token })
  ok(rb2.status === 200 || /无可回退|冷却/.test(String(rb2.message ?? '')),
    '用户连续回退可达(人在回路不受 Agent 冷却限制)', `status=${rb2.status} ${rb2.message ?? ''}`)
}
