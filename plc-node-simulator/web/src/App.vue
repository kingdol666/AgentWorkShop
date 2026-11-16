<script setup>
/** PLC 节点模拟器 UI —— 设备列表 / 编辑器 / 实时监视 / 对接导出 */
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue'

/* ── 状态 ── */
const nodes = ref([])
const toast = ref('')
let ws = null
let toastTimer = null
const say = (m) => { toast.value = m; clearTimeout(toastTimer); toastTimer = setTimeout(() => (toast.value = ''), 2200) }

const api = async (path, method = 'GET', body) => {
  const res = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  const j = await res.json().catch(() => ({}))
  if (j.code !== 0) throw new Error(j.message || `HTTP ${res.status}`)
  return j.data
}
const reload = async () => { nodes.value = await api('/api/nodes') }

/* ── WS 实时 ──
 * 服务端每台设备各推一帧 signal.update(nodeId = 真实设备 id),
 * 前端按 nodeId + signalId 落到卡片上;同时统计帧率/最后到达时间并显示在页头,
 * 让"是不是真的在实时"变成一眼可见的状态,而不是靠盯着数字猜。 */
const liveValues = reactive({}) // nodeId -> { sigId: { value, hist } }
const wsState = ref('connecting') // connecting | open | closed
const wsFps = ref(0)
const wsLastAt = ref(0)
let wsFrames = 0
let wsFpsTimer = null

function connectWs() {
  wsState.value = 'connecting'
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
  ws.onopen = () => { wsState.value = 'open' }
  ws.onmessage = (ev) => {
    try {
      const f = JSON.parse(ev.data)
      if (f.type !== 'signal.update') return
      const lv = (liveValues[f.payload.nodeId] ??= {})
      for (const s of f.payload.signals) {
        const cur = (lv[s.id] ??= { value: 0, hist: [] })
        cur.value = s.value
        cur.hist.push(s.value)
        if (cur.hist.length > 60) cur.hist.shift()
      }
      wsFrames++
      wsLastAt.value = Date.now()
    }
    catch { /* 忽略坏帧 */ }
  }
  ws.onclose = () => {
    wsState.value = 'closed'
    wsFps.value = 0
    setTimeout(connectWs, 2000)
  }
  ws.onerror = () => { wsState.value = 'closed' }
}

/** 帧率按秒统计(用于页头"实时"指示) */
const wsLabel = computed(() => {
  if (wsState.value === 'open') return `实时 WS · ${wsFps.value} 帧/s`
  if (wsState.value === 'connecting') return '连接中…'
  return '已断开 · 重连中'
})

/* ── 协议元数据(动态表单 schema) ── */
const PROTOCOLS = {
  'modbus-tcp': { label: 'Modbus TCP', fields: [{ k: 'host', t: 'text', d: '0.0.0.0' }, { k: 'port', t: 'number', d: 16040 }, { k: 'unitId', t: 'number', d: 1 }], map: 'registerMaps' },
  'modbus-rtu': { label: 'Modbus RTU(TCP)', fields: [{ k: 'host', t: 'text', d: '0.0.0.0' }, { k: 'port', t: 'number', d: 15041 }, { k: 'unitId', t: 'number', d: 1 }, { k: 'rtuMode', t: 'select', opts: ['mbap', 'raw-rtu'], d: 'mbap' }], map: 'registerMaps' },
  opcua: { label: 'OPC UA Server', fields: [{ k: 'host', t: 'text', d: '127.0.0.1' }, { k: 'port', t: 'number', d: 5840 }, { k: 'namespaceUri', t: 'text', d: 'PLC-Simulator' }, { k: 'username', t: 'text', d: '' }, { k: 'password', t: 'text', d: '' }], map: 'opcVars' },
  mqtt: { label: 'MQTT 发布', fields: [{ k: 'brokerUrl', t: 'text', d: 'mqtt://127.0.0.1:18830' }, { k: 'username', t: 'text', d: '' }, { k: 'password', t: 'text', d: '' }, { k: 'commandTopic', t: 'text', d: 'aw/sim/setpoint' }], map: 'topics' },
  http: { label: 'HTTP 端点', fields: [], map: 'paths' },
}
const STRATEGIES = {
  constant: { label: '恒值', fields: { value: { label: '值', def: 50 } } },
  manual: { label: '手动覆写', fields: { value: { label: '值', def: 50 } } },
  sine: { label: '正弦', fields: { base: { label: '基线', def: 50 }, amp: { label: '幅值', def: 5 }, periodMs: { label: '周期ms', def: 10000 } } },
  'random-walk': { label: '随机游走', fields: { start: { label: '起点', def: 50 }, step: { label: '步长', def: 1 }, min: { label: '下限', def: 0 }, max: { label: '上限', def: 100 } } },
  ramp: { label: '斜坡', fields: { start: { label: '起点', def: 0 }, end: { label: '终点', def: 100 }, durationMs: { label: '时长ms', def: 60000 }, loop: { label: '循环', type: 'bool', def: true } } },
  'first-order': { label: '一阶惯性(SP闭环)', fields: { initial: { label: '初值', def: 20 }, tauMs: { label: '时间常数ms', def: 8000 }, sp: { label: '设定值SP', def: 180 }, noise: { label: '噪声', def: 0.2 } } },
  expression: { label: '表达式', fields: { expr: { label: '表达式([信号名]引用)', def: '[温度PV] * 0.5' } } },
}
const DATA_TYPES = ['float32', 'int16', 'uint16', 'int32', 'uint32']
const BYTE_ORDERS = ['big', 'little', 'wordSwap']

/* ── 编辑器 ── */
const editing = ref(null) // 编辑中的设备副本
const showEditor = ref(false)
const editingIsNew = ref(false)

function blankSignal() {
  return { id: `sig-${Math.random().toString(16).slice(2, 8)}`, name: '新信号', unit: '', decimals: 2, strategy: { kind: 'constant', value: 50 }, faults: { spike: { probability: 0.01, durationMs: 3000, overshoot: 0.2 }, disconnect: { durationMs: 8000 } } }
}
/** faults 规范化:嵌套对象预建(模板绑定安全) + UI 开关字段 */
function normFaults(s) {
  const f = s.faults ?? {}
  const spike = f.spike ?? { probability: 0.01, durationMs: 3000, overshoot: 0.2 }
  const disconnect = f.disconnect ?? { durationMs: 8000 }
  s.faults = { stuckAt: Boolean(f.stuckAt), spike, disconnect, spikeOn: Boolean(f.spike), disconnectOn: Boolean(f.disconnect) }
}
/** 保存前清洗:UI 开关字段 → 实际故障注入结构 */
function cleanFaults(s) {
  const f = s.faults ?? {}
  const out = {}
  if (f.stuckAt) out.stuckAt = true
  if (f.spikeOn && f.spike) out.spike = { probability: Number(f.spike.probability) || 0.01, durationMs: Number(f.spike.durationMs) || 3000, overshoot: Number(f.spike.overshoot) || 0.2 }
  if (f.disconnectOn && f.disconnect) out.disconnect = { durationMs: Number(f.disconnect.durationMs) || 8000 }
  s.faults = out
}
function openCreate() {
  editingIsNew.value = true
  const n = { id: null, name: '新设备', protocol: 'modbus-tcp', enabled: true, tickMs: 1000, signals: [blankSignal()], config: { host: '0.0.0.0', port: 16040, unitId: 1, registerMaps: [] } }
  n.signals.forEach(normFaults)
  editing.value = reactive(n)
  showEditor.value = true
}
function openEdit(n) {
  editingIsNew.value = false
  const copy = JSON.parse(JSON.stringify({ ...n, runtime: undefined, signals: n.signals.map(({ value, hist, ...s }) => s) }))
  copy.signals.forEach(normFaults)
  editing.value = reactive(copy)
  showEditor.value = true
}
function onProtocolChange() {
  const cfg = editing.value.config
  editing.value.config = {}
  for (const f of PROTOCOLS[editing.value.protocol].fields) editing.value.config[f.k] = f.d
  editing.value.config[PROTOCOLS[editing.value.protocol].map] = cfg[PROTOCOLS[editing.value.protocol].map] ?? []
}
function addSignal() { editing.value.signals.push(blankSignal()) }
function delSignal(i) { editing.value.signals.splice(i, 1) }
function addMapRow() {
  const m = PROTOCOLS[editing.value.protocol].map
  const sig0 = editing.value.signals[0]?.id
  const arr = (editing.value.config[m] ??= [])
  if (m === 'registerMaps') arr.push({ address: 40001, area: 'holding', signalId: sig0, dataType: 'float32', byteOrder: 'big' })
  else if (m === 'opcVars') arr.push({ nodeId: 'ns=2;s=Tag1', signalId: sig0, dataType: 'Double', writable: false })
  else if (m === 'topics') arr.push({ topic: 'aw/sim/data', signalId: sig0, payloadTemplate: '{"data":{"value":${value}}}', qos: 0, retain: false })
  else if (m === 'paths') arr.push({ path: '/api/value', signalId: sig0, responseTemplate: '{"data":{"value":${value}}}' })
}
const saveEditor = async () => {
  try {
    editing.value.signals.forEach(cleanFaults)
    if (editingIsNew.value) await api('/api/nodes', 'POST', editing.value)
    else await api(`/api/nodes/${editing.value.id}`, 'PATCH', editing.value)
    showEditor.value = false
    say('已保存并重启端点')
    reload()
  }
  catch (e) { say(`保存失败: ${e.message}`) }
}

/* ── 启停/删除/预设/手动覆写 ── */
const toggle = async (n) => { await api(`/api/nodes/${n.id}/${n.runtime.running ? 'stop' : 'start'}`, 'POST'); reload() }
const remove = async (n) => { if (confirm(`删除设备「${n.name}」?`)) { await api(`/api/nodes/${n.id}`, 'DELETE'); reload() } }
const applyPreset = async () => { await api('/api/presets/film-line', 'POST'); say('薄膜双拉产线预设已应用'); reload() }
const setManual = async (n, s) => {
  const v = prompt(`手动覆写「${s.name}」的值:`, String(s.value))
  if (v === null) return
  await api(`/api/nodes/${n.id}/signals/${s.id}/manual`, 'POST', { value: Number(v) })
  reload()
}

/* ── 对接导出 ── */
const exportData = ref(null)
const showExport = ref(false)
const openExport = async (n) => { exportData.value = await api(`/api/nodes/${n.id}/export`); showExport.value = true }
const copyText = async (t) => { try { await navigator.clipboard.writeText(t); say('已复制') } catch { say('复制失败') } }
const exportJson = computed(() => JSON.stringify(exportData.value?.items?.map(i => ({ driver: i.driver, driverConfig: i.driverConfig })) ?? [], null, 2))

const exportAll = ref(false)
const importText = ref('')
const showImport = ref(false)
const doExportAll = async () => { exportAll.value = await api('/api/config'); showImport.value = true; importText.value = '' }
const doImportAll = async () => {
  try {
    const parsed = JSON.parse(importText.value)
    await api('/api/config', 'PUT', parsed)
    say('配置已导入'); showImport.value = false; reload()
  }
  catch (e) { say(`导入失败: ${e.message}`) }
}

const valOf = (n, s) => liveValues[n.id]?.[s.id]?.value ?? s.value
const histOf = (n, s) => {
  const h = liveValues[n.id]?.[s.id]?.hist
  return (h && h.length > 1) ? h : (s.hist ?? [])
}
const sparkPath = (hist) => {
  if (!hist || hist.length < 2) return ''
  const min = Math.min(...hist)
  const max = Math.max(...hist)
  const span = max - min || 1
  return hist.map((v, i) => `${(i / (hist.length - 1)) * 100},${22 - ((v - min) / span) * 20 - 1}`).join(' ')
}
const endpointText = (n) => {
  const c = n.config ?? {}
  switch (n.protocol) {
    case 'modbus-tcp': return `Modbus TCP ${c.host}:${c.port} (unit ${c.unitId})`
    case 'modbus-rtu': return `RTU/TCP ${c.host}:${c.port} (${c.rtuMode ?? 'mbap'})`
    case 'opcua': return `opc.tcp://${c.host}:${c.port}`
    case 'mqtt': return `→ ${c.brokerUrl}`
    case 'http': return (c.paths ?? []).map(p => `/sim-http/${n.id}${p.path}`).join(' ')
    default: return ''
  }
}

onMounted(() => {
  reload()
  connectWs()
  wsFpsTimer = setInterval(() => {
    wsFps.value = wsFrames
    wsFrames = 0
  }, 1000)
})
onUnmounted(() => {
  ws?.close()
  clearInterval(wsFpsTimer)
})
</script>

<template>
  <div class="shell">
    <header class="head">
      <h1>PLC 节点模拟器</h1>
      <span class="sub">多协议虚拟工业设备 · Modbus TCP/RTU · OPC UA · MQTT · HTTP</span>
      <span class="live" :class="wsState" :title="wsLastAt ? '最后收到数据 ' + new Date(wsLastAt).toLocaleTimeString() : '尚未收到数据'">
        <span class="live-dot" />{{ wsLabel }}
      </span>
      <span class="spacer" />
      <button class="btn ghost" @click="doExportAll">导出配置</button>
      <button class="btn ghost" @click="showImport = true">导入配置</button>
      <button class="btn" @click="applyPreset">薄膜产线预设</button>
      <button class="btn primary" @click="openCreate">+ 新建设备</button>
    </header>

    <div v-if="nodes.length === 0" class="empty">
      暂无设备 —— 点击右上角「薄膜产线预设」一键生成五协议模拟产线,或「+ 新建设备」。
    </div>

    <div class="grid">
      <div v-for="n in nodes" :key="n.id" class="card" :class="{ off: !n.enabled }">
        <div class="bar">
          <span class="dot" :class="n.runtime.lastError ? 'err' : n.runtime.running ? 'on' : ''" />
          <span class="name">{{ n.name }}</span>
          <span class="badge protocol">{{ PROTOCOLS[n.protocol]?.label ?? n.protocol }}</span>
          <span class="endpoint">{{ endpointText(n) }}</span>
        </div>
        <div class="body">
          <div v-for="s in n.signals" :key="s.id" class="sigrow" :title="`${s.strategy.kind} · 点击数值可手动覆写`">
            <span class="sig-name">{{ s.name }}</span>
            <svg viewBox="0 0 100 22" preserveAspectRatio="none"><polyline :points="sparkPath(histOf(n, s))" /></svg>
            <span class="sig-val" style="cursor:pointer" @click="setManual(n, s)">{{ valOf(n, s) }}</span>
            <span class="sig-unit" style="grid-column: 1">{{ s.unit }}</span>
          </div>
        </div>
        <div v-if="n.runtime.lastError" class="err-line">⚠ {{ n.runtime.lastError }}</div>
        <div class="acts">
          <button class="btn" @click="toggle(n)">{{ n.runtime.running ? '停止' : '启动' }}</button>
          <button class="btn" @click="openEdit(n)">编辑</button>
          <button class="btn" @click="openExport(n)">对接导出</button>
          <span class="spacer" style="flex:1" />
          <button class="btn danger ghost" @click="remove(n)">删除</button>
        </div>
      </div>
    </div>

    <!-- 编辑器 -->
    <div v-if="showEditor" class="mask" @click.self="showEditor = false">
      <div class="modal" style="width: 860px">
        <div class="m-head"><b>{{ editingIsNew ? '新建设备' : `编辑 · ${editing.name}` }}</b><button class="btn ghost x" @click="showEditor = false">✕</button></div>
        <div class="m-body" v-if="editing">
          <div class="sect"><div class="t">基本</div><div class="c">
            <div class="row">
              <label class="fld">名称<input class="inp" v-model="editing.name" /></label>
              <label class="fld">协议
                <select class="inp" v-model="editing.protocol" :disabled="!editingIsNew" @change="onProtocolChange">
                  <option v-for="(p, k) in PROTOCOLS" :key="k" :value="k">{{ p.label }}</option>
                </select>
              </label>
              <label class="fld">节拍 tickMs<input class="inp" type="number" v-model.number="editing.tickMs" /></label>
              <label class="fld">启用
                <select class="inp" v-model.number="editing.enabled"><option :value="true">是</option><option :value="false">否</option></select>
              </label>
            </div>
          </div></div>

          <div class="sect"><div class="t">通信配置({{ PROTOCOLS[editing.protocol].label }})</div><div class="c">
            <div class="row">
              <label v-for="f in PROTOCOLS[editing.protocol].fields" :key="f.k" class="fld">{{ f.k }}
                <select v-if="f.t === 'select'" class="inp" v-model="editing.config[f.k]"><option v-for="o in f.opts" :key="o" :value="o">{{ o }}</option></select>
                <input v-else class="inp" :type="f.t" v-model="editing.config[f.k]" :placeholder="String(f.d)" />
              </label>
            </div>
            <!-- 映射表 -->
            <table class="tbl" v-if="editing.protocol === 'modbus-tcp' || editing.protocol === 'modbus-rtu'">
              <thead><tr><th>地址</th><th>区</th><th>信号</th><th>类型</th><th>字节序</th><th></th></tr></thead>
              <tbody>
                <tr v-for="(m, i) in editing.config.registerMaps" :key="i">
                  <td><input class="inp" type="number" v-model.number="m.address" /></td>
                  <td><select class="inp" v-model="m.area"><option value="holding">4x保持</option><option value="input">3x输入</option></select></td>
                  <td><select class="inp" v-model="m.signalId"><option v-for="s in editing.signals" :key="s.id" :value="s.id">{{ s.name }}</option></select></td>
                  <td><select class="inp" v-model="m.dataType"><option v-for="d in DATA_TYPES" :key="d">{{ d }}</option></select></td>
                  <td><select class="inp" v-model="m.byteOrder"><option v-for="b in BYTE_ORDERS" :key="b">{{ b }}</option></select></td>
                  <td><button class="btn danger ghost" @click="editing.config.registerMaps.splice(i, 1)">✕</button></td>
                </tr>
              </tbody>
            </table>
            <table class="tbl" v-else-if="editing.protocol === 'opcua'">
              <thead><tr><th>NodeId</th><th>信号</th><th>类型</th><th>可写SP</th><th></th></tr></thead>
              <tbody>
                <tr v-for="(m, i) in editing.config.opcVars" :key="i">
                  <td><input class="inp" v-model="m.nodeId" /></td>
                  <td><select class="inp" v-model="m.signalId"><option v-for="s in editing.signals" :key="s.id" :value="s.id">{{ s.name }}</option></select></td>
                  <td><select class="inp" v-model="m.dataType"><option v-for="d in ['Double','Float','Int16','UInt16','Int32','UInt32','Boolean']" :key="d">{{ d }}</option></select></td>
                  <td><input type="checkbox" v-model="m.writable" /></td>
                  <td><button class="btn danger ghost" @click="editing.config.opcVars.splice(i, 1)">✕</button></td>
                </tr>
              </tbody>
            </table>
            <table class="tbl" v-else-if="editing.protocol === 'mqtt'">
              <thead><tr><th>主题</th><th>信号</th><th>payload 模板</th><th>QoS</th><th></th></tr></thead>
              <tbody>
                <tr v-for="(m, i) in editing.config.topics" :key="i">
                  <td><input class="inp" v-model="m.topic" /></td>
                  <td><select class="inp" v-model="m.signalId"><option v-for="s in editing.signals" :key="s.id" :value="s.id">{{ s.name }}</option></select></td>
                  <td><input class="inp" v-model="m.payloadTemplate" /></td>
                  <td><select class="inp" v-model.number="m.qos"><option :value="0">0</option><option :value="1">1</option></select></td>
                  <td><button class="btn danger ghost" @click="editing.config.topics.splice(i, 1)">✕</button></td>
                </tr>
              </tbody>
            </table>
            <table class="tbl" v-else-if="editing.protocol === 'http'">
              <thead><tr><th>路径</th><th>信号</th><th>响应模板</th><th></th></tr></thead>
              <tbody>
                <tr v-for="(m, i) in editing.config.paths" :key="i">
                  <td><input class="inp" v-model="m.path" /></td>
                  <td><select class="inp" v-model="m.signalId"><option v-for="s in editing.signals" :key="s.id" :value="s.id">{{ s.name }}</option></select></td>
                  <td><input class="inp" v-model="m.responseTemplate" /></td>
                  <td><button class="btn danger ghost" @click="editing.config.paths.splice(i, 1)">✕</button></td>
                </tr>
              </tbody>
            </table>
            <button class="btn" @click="addMapRow">+ 添加映射行</button>
            <div class="hint">映射行把信号值绑定到协议地址/主题/端点;主项目 /daq 添加节点时按此对应。</div>
          </div></div>

          <div class="sect"><div class="t">信号(要发出的数据)</div><div class="c">
            <table class="tbl">
              <thead><tr><th style="width:150px">名称</th><th style="width:70px">单位</th><th style="width:120px">策略</th><th>策略参数</th><th style="width:60px">小数</th><th style="width:210px">故障注入</th><th></th></tr></thead>
              <tbody>
                <tr v-for="(s, i) in editing.signals" :key="s.id">
                  <td><input class="inp" v-model="s.name" /></td>
                  <td><input class="inp" v-model="s.unit" /></td>
                  <td>
                    <select class="inp" :value="s.strategy.kind" @change="s.strategy = { kind: $event.target.value, ...(Object.fromEntries(Object.entries(STRATEGIES[$event.target.value].fields).map(([k, f]) => [k, f.def]))) }">
                      <option v-for="(st, k) in STRATEGIES" :key="k" :value="k">{{ st.label }}</option>
                    </select>
                  </td>
                  <td>
                    <div class="row" style="gap:6px">
                      <label v-for="(f, k) in STRATEGIES[s.strategy.kind].fields" :key="k" class="fld" style="min-width:70px;flex:none">{{ f.label }}
                        <select v-if="f.type === 'bool'" class="inp" v-model="s.strategy[k]"><option :value="true">是</option><option :value="false">否</option></select>
                        <input v-else class="inp" style="width:80px" type="number" step="any" v-model="s.strategy[k]" />
                      </label>
                    </div>
                  </td>
                  <td><input class="inp" type="number" v-model.number="s.decimals" /></td>
                  <td>
                    <div class="row" style="gap:6px;align-items:center">
                      <label class="hint"><input type="checkbox" v-model="s.faults.stuckAt" />卡值</label>
                      <label class="hint"><input type="checkbox" v-model="s.faults.spikeOn" />尖峰</label>
                      <label class="hint" v-if="s.faults.spikeOn">越限<input class="inp" style="width:52px" type="number" step="0.01" v-model.number="s.faults.spike.overshoot" /></label>
                      <label class="hint"><input type="checkbox" v-model="s.faults.disconnectOn" />断链</label>
                      <label class="hint" v-if="s.faults.disconnectOn">ms<input class="inp" style="width:60px" type="number" v-model.number="s.faults.disconnect.durationMs" /></label>
                    </div>
                  </td>
                  <td><button class="btn danger ghost" @click="delSignal(i)">✕</button></td>
                </tr>
              </tbody>
            </table>
            <button class="btn" @click="addSignal">+ 添加信号</button>
          </div></div>
        </div>
        <div class="m-foot">
          <button class="btn ghost" @click="showEditor = false">取消</button>
          <button class="btn primary" @click="saveEditor">保存并重启端点</button>
        </div>
      </div>
    </div>

    <!-- 对接导出 -->
    <div v-if="showExport" class="mask" @click.self="showExport = false">
      <div class="modal">
        <div class="m-head"><b>对接导出 · {{ exportData?.device?.name }}</b><button class="btn ghost x" @click="showExport = false">✕</button></div>
        <div class="m-body">
          <div class="hint">在 AgentWorkShop 的 /daq 页「添加节点 → 真实协议」中,按下列 driver + driverConfig 逐信号建节点(或直接用 curl 调 REST)。</div>
          <div v-for="it in exportData?.items ?? []" :key="it.signal" class="sect">
            <div class="t">{{ it.signal }} · driver = {{ it.driver }}
              <button class="btn ghost" style="float:right;margin-top:-2px" @click="copyText(JSON.stringify({ driver: it.driver, driverConfig: it.driverConfig }))">复制</button>
            </div>
            <div class="c"><pre class="code">{{ JSON.stringify(it.driverConfig, null, 2) }}</pre></div>
          </div>
          <div class="sect">
            <div class="t">批量 JSON(POST /api/workshop/daq body 片段)
              <button class="btn ghost" style="float:right;margin-top:-2px" @click="copyText(exportJson)">复制</button>
            </div>
            <div class="c"><pre class="code">{{ exportJson }}</pre></div>
          </div>
        </div>
      </div>
    </div>

    <!-- 导入/导出配置 -->
    <div v-if="showImport" class="mask" @click.self="showImport = false">
      <div class="modal">
        <div class="m-head"><b>{{ exportAll ? '导出配置' : '导入配置' }}</b><button class="btn ghost x" @click="showImport = false; exportAll = false">✕</button></div>
        <div class="m-body">
          <template v-if="exportAll">
            <pre class="code">{{ JSON.stringify(exportAll, null, 2) }}</pre>
            <button class="btn" @click="copyText(JSON.stringify(exportAll))">复制 JSON</button>
          </template>
          <template v-else>
            <div class="hint">粘贴此前导出的配置 JSON 并应用(会替换全部设备)。</div>
            <textarea class="inp" rows="12" v-model="importText" style="font-family:inherit"></textarea>
            <button class="btn primary" @click="doImportAll">应用导入</button>
          </template>
        </div>
      </div>
    </div>

    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>
