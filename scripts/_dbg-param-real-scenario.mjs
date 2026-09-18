/**
 * 真实场景测试:用户/Agent 只管工艺参数(设温度多少度),PLC 细节由标准转换模式封装。
 *
 *  前置:隔离 AW 实例(E2E_ROOT,首注册即 admin)+ 运行中的 plc-node-simulator(E2E_SIM_API)。
 *  ①配置阶段(集成工程师,一次性):取模拟器「对接导出」→ 以标准转换模式(float32)一键建工艺参数映射
 *  ②运行阶段(用户视角):参数列表(无寄存器细节)→ 设 温度185/210 → 模拟器 API 确认真实收到 →
 *    参数读回一致 → 越基准限界 400 → 模拟器侧手动改值 → 用户参数读到新值(读方向同样自动换算)
 *  ③收尾:模拟器信号值复原 + 产线 purge。
 * 运行: node scripts/_dbg-param-real-scenario.mjs
 */
const ROOT = process.env.E2E_ROOT ?? 'http://127.0.0.1:3399'
const SIM_API = process.env.E2E_SIM_API ?? 'http://127.0.0.1:4010'
let failed = 0
const check = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) failed++ }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const j = async (base, u, m = 'GET', b, h = {}) => {
  const r = await fetch(base + u, { method: m, headers: { 'content-type': 'application/json', ...h }, body: b ? JSON.stringify(b) : undefined }).then(x => x.json())
  if (r.error) return { ...r, _status: r.statusCode }
  return r
}

// ---- 认证:AW_E2E_TOKEN > token 缓存文件(首注册即 admin,复跑复用) > 现场注册 ----
let token = process.env.AW_E2E_TOKEN
const tokenFile = process.env.AW_SCENE_TOKEN_FILE ?? '.tmp-scene-home/admin-token.txt'
if (!token) {
  try {
    token = (await import('node:fs')).readFileSync(tokenFile, 'utf8').trim() || null
  }
  catch { /* 无缓存 */ }
  if (token) check('复用已缓存管理员 token', true)
}
if (!token) {
  const reg = await j(ROOT, '/api/workshop/users/register', 'POST', { name: `scene-admin-${Date.now().toString(36)}` })
  token = reg.data?.token
  check('注册管理员(隔离实例,首注册即 admin)', !!token)
  if (token) {
    try {
      ;(await import('node:fs')).mkdirSync(tokenFile.replace(/[/\\][^/\\]+$/, ''), { recursive: true })
      ;(await import('node:fs')).writeFileSync(tokenFile, token)
    }
    catch { /* 缓存失败不影响本次 */ }
  }
}
const H = { authorization: `Bearer ${token}` }
const api = (u, m = 'GET', b) => j(ROOT, u, m, b, H)
const sim = (u, m = 'GET', b) => j(SIM_API, u, m, b)

try {
  // ---- ① 配置阶段(一次性;模拟器导出 → 标准转换模式建映射) ----
  console.log('\n--- ① 配置阶段:模拟器对接导出 → 标准转换模式一键建工艺参数映射 ---')
  const nodes = await sim('/api/nodes')
  const dev = (nodes.data ?? []).find(n => n.protocol === 'modbus-tcp')
  check('发现 plc-node-simulator Modbus TCP 设备', !!dev?.id, `${dev?.id}(${dev?.name})`)
  const exp = await sim(`/api/nodes/${dev.id}/export`)
  const items = exp.data?.items ?? []
  check('导出对接配置(寄存器/数据类型/字节序由模拟器给出)', items.length >= 2, items.map(i => `${i.signal}@${i.driverConfig.register}`).join(', '))

  const line = (await api('/api/workshop/dcw/lines', 'POST', { name: '1号挤出线(参数映射)' })).data?.line
  check('创建产线', !!line?.id)

  // 两个工艺参数:加热区1/加热区2 温度,float32 直写标准模式,基准限界 160~190(收窄于模板量程 150~200)
  const mkParam = async (item, key, name) => {
    const cfg = item.driverConfig
    const r = await api('/api/workshop/dcw/params', 'POST', {
      key, name, templateRef: 'dcw-temp-sp', lineId: line.id,
      min: 160, max: 190,
      access: {
        host: cfg.host, port: cfg.port, unitId: cfg.unitId, register: cfg.register,
        conversion: { mode: 'float32', byteOrder: cfg.byteOrder },
      },
    })
    return r.data?.param
  }
  const p1 = await mkParam(items[0], 'zone1_temp', '加热区1温度设定')
  const p2 = await mkParam(items[1], 'zone2_temp', '加热区2温度设定')
  check('工艺参数「zone1_temp」建映射成功(自动建执行节点)', !!p1?.id && !!p1.nodeId, `${p1?.id} → ${p1?.nodeId}`)
  check('转换模式已留存(float32)', p1?.conversion?.mode === 'float32')
  check('映射视图不含寄存器/数据类型(用户不可见)', !JSON.stringify(p1).includes('register') && !JSON.stringify(p1).includes('dataType'))

  // ---- ② 运行阶段(用户只碰 key + 工程值) ----
  console.log('\n--- ② 运行阶段:用户设定工艺参数 → 模拟器真实接收 → 参数读回 ---')
  const list = await api('/api/workshop/dcw/params?lineId=' + line.id)
  check('用户参数列表(2 条工艺参数)', (list.data?.params ?? []).length === 2, list.data?.params?.map(p => `${p.key}=${p.value}${p.unit}`).join(', '))

  const simValueOf = async (signalName) => {
    const ns = await sim('/api/nodes')
    const sg = (ns.data ?? []).find(n => n.id === dev.id)?.signals?.find(s => s.name === signalName || s.id === signalName)
    return sg?.value
  }
  const userSet = async (param, value) => {
    const w = await api(`/api/workshop/dcw/params/${param.id}/write`, 'POST', { value })
    return { ok: w.data?.outcome?.ok, msg: w.data?.outcome?.message ?? w.message }
  }
  const userRead = async (param) => {
    const r = await api(`/api/workshop/dcw/params/${param.id}/read`, 'POST', {})
    return { value: r.data?.read?.value, ok: r.data?.read?.ok, msg: r.data?.read?.message }
  }
  // 模拟器 SP 可能带一阶收敛,轮询直至到位
  const waitSimValue = async (signalName, target, timeoutMs = 8000) => {
    const t0 = Date.now()
    for (;;) {
      const v = await simValueOf(signalName)
      if (v != null && Math.abs(v - target) <= 0.6) return v
      if (Date.now() - t0 > timeoutMs) return v
      await sleep(400)
    }
  }

  console.log('  · 用户设定 加热区1温度 = 185℃')
  const w1 = await userSet(p1, 185)
  check('用户写入 185℃ 成功(含 PLC 回读确认)', w1.ok === true, w1.msg)
  const sv1 = await waitSimValue(items[0].signal, 185)
  check('PLC 模拟器真实收到:zone1 SP = 185', sv1 != null && Math.abs(sv1 - 185) <= 0.6, `sim.value=${sv1}`)
  const r1 = await userRead(p1)
  check('用户按参数读回 = 185℃(工程量纲)', r1.ok && Math.abs((r1.value ?? 0) - 185) <= 0.6, `value=${r1.value}`)

  console.log('  · 用户设定 加热区2温度 = 175℃')
  const w2 = await userSet(p2, 175)
  check('用户写入 175℃ 成功', w2.ok === true, w2.msg)
  const sv2 = await waitSimValue(items[1].signal, 175)
  check('PLC 模拟器真实收到:zone2 SP = 175', sv2 != null && Math.abs(sv2 - 175) <= 0.6, `sim.value=${sv2}`)

  console.log('  · 用户越界尝试 195℃...基准限界上限是 190(节点量程 150~200 之内)')
  const w3 = await api(`/api/workshop/dcw/params/${p2.id}/write`, 'POST', { value: 195 })
  check('越基准限界 → 400 点名参数层(用户不可越界)', (w3._status === 400 || w3.code === 'VALIDATION_ERROR') && String(w3.message).includes('基准限界'), String(w3.message).slice(0, 80))

  console.log('  · 现场侧把 zone1 就地改到 172℃(模拟读方向)')
  // 模拟器 manual 接口按信号 id 寻址(导出的 signal 字段是中文名,先换 id)
  const simSignals = (await sim('/api/nodes')).data?.find(n => n.id === dev.id)?.signals ?? []
  const signalIdOf = (name) => simSignals.find(s => s.name === name || s.id === name)?.id
  await sim(`/api/nodes/${dev.id}/signals/${signalIdOf(items[0].signal)}/manual`, 'POST', { value: 172 })
  await sleep(600)
  const r2 = await userRead(p1)
  check('用户参数读到现场实际值 172℃(接收方向同样自动换算)', r2.ok && Math.abs((r2.value ?? 0) - 172) <= 0.6, `value=${r2.value}`)

  // ---- ③ 收尾 ----
  console.log('\n--- ③ 收尾:模拟器复原 + 产线清理 ---')
  for (const item of items.slice(0, 2)) {
    await sim(`/api/nodes/${dev.id}/signals/${signalIdOf(item.signal)}/manual`, 'POST', { value: 200 })
  }
  const back1 = await waitSimValue(items[0].signal, 200, 5000)
  check('模拟器信号值复原(200)', back1 != null && Math.abs(back1 - 200) <= 0.6, `sim.value=${back1}`)
  await api(`/api/workshop/dcw/lines/${line.id}?purge=1`, 'DELETE')
  const after = await api('/api/workshop/dcw/params')
  check('产线 purge 后工艺参数映射清零', !(after.data?.params ?? []).some(p => [p1.id, p2.id].includes(p.id)))
}
catch (err) {
  failed += 1
  console.error('场景异常中断:', err)
}

console.log(`\n${failed === 0 ? '✅ 真实场景全部通过' : `❌ ${failed} 项失败`}`)
process.exit(failed === 0 ? 0 : 1)
