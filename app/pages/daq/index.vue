<script setup lang="ts">
/**
 * 数采中心(DAQ Console)—— server 驱动数采的总控面。
 * 后端能力自描述(tsdb/queue/驱动族 + 管线指标)、控制器全局启停/周期、
 * 节点清单(状态/实时值/周期/绑定/驱动),点进 /daq/[id] 进入单节点专业控制台。
 */
import { onBeforeUnmount, onMounted } from 'vue'
import { useDaqStream } from '@/app/composables/workshop/useDaqStream'
import { useDeviceTwins } from '@/app/composables/workshop/useDeviceTwins'
import { DAQ_TEMPLATES, DAQ_DRIVERS, daqKeyFromRef, type DaqNodeState, type DriverConfigField, type DaqDriverTestResult } from '#shared/daq-protocol'

definePageMeta({ layout: 'default' })
useHead({ title: '数采中心 · AgentWorkShop' })

const daq = useDaqStream()
let unsub: (() => void) | null = null
let redrawTimer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  unsub = daq.ensureWsFeed()
  void daq.load()
  // meta 指标随读数帧落库节奏低频刷新(诚实可见的管线运行数据)
  redrawTimer = setInterval(() => void daq.load(), 5000)
})
onBeforeUnmount(() => {
  unsub?.()
  if (redrawTimer) clearInterval(redrawTimer)
})

const deviceName = (id: string | null): string =>
  id ? (nodeDevices.get(id) ?? `${id.slice(0, 8)}…`) : '未绑定'

// 设备名映射(device-twins 注册表;绑定列展示用)
const deviceTwins = useDeviceTwins()
const nodeDevices = new Map<string, string>()
watch(() => deviceTwins.twins, (list) => {
  for (const t of list) nodeDevices.set(t.id, t.name)
}, { immediate: true, deep: true })

const intervalOf = (intervalMs: number | null): string => {
  if (intervalMs == null) return `全局 ${daq.controller.defaultIntervalMs}ms`
  return `${intervalMs}ms`
}

const stateLabel: Record<DaqNodeState, string> = {
  ok: '正常',
  warn: '预警',
  alarm: '告警',
  offline: '离线',
}

// ---------- 添加节点向导(mock / 真实场景 + 动态参数表单 + 测试连接) ----------
const addOpen = ref(false)
const addScenario = ref<'mock' | 'real'>('mock')
const addTemplate = ref(DAQ_TEMPLATES[0]?.key ?? 'temp-tc')
const addDriver = ref('modbus-tcp')
const addName = ref('')
const addInterval = ref<number | null>(null)
const addCfg = ref<Record<string, string | number>>({})
const addTesting = ref(false)
const addTest = ref<DaqDriverTestResult | null>(null)
const addSaving = ref(false)
const addError = ref('')

const addDriverMeta = computed(() => DAQ_DRIVERS.find(d => d.kind === addDriver.value))
const addFields = computed<DriverConfigField[]>(() => addDriverMeta.value?.configFields ?? [])
const driverReady = (kind: string): boolean =>
  daq.meta.drivers.find(d => d.kind === kind)?.status !== 'planned' && (daq.meta.driverAvailable?.[kind] !== false)

watch(addDriver, () => {
  // 切协议:表单重置为 schema 缺省值
  const cfg: Record<string, string | number> = {}
  for (const f of addFields.value) {
    if (f.default !== undefined) cfg[f.key] = f.default as string | number
  }
  addCfg.value = cfg
  addTest.value = null
}, { immediate: true })

async function doTestConnection(): Promise<void> {
  addTesting.value = true
  addTest.value = null
  try {
    addTest.value = await daq.testDriver(addDriver.value, addCfg.value)
  }
  catch (err) {
    addTest.value = { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
  finally {
    addTesting.value = false
  }
}

async function doAddNode(): Promise<void> {
  addSaving.value = true
  addError.value = ''
  try {
    if (addScenario.value === 'mock') {
      await daq.createFromTemplate(`daq-${addTemplate.value}`, addName.value ? { name: addName.value } : undefined)
    }
    else {
      // 校验必填
      for (const f of addFields.value) {
        if (f.required && !addCfg.value[f.key] && addCfg.value[f.key] !== 0) {
          throw new Error(`缺少必填参数:${f.label}`)
        }
      }
      await daq.createFromTemplate(`daq-${addTemplate.value}`, {
        name: addName.value || undefined,
        driver: addDriver.value as never,
        driverConfig: { ...addCfg.value },
        intervalMs: addInterval.value,
        unit: DAQ_TEMPLATES.find(t => t.key === addTemplate.value)?.unit,
        min: DAQ_TEMPLATES.find(t => t.key === addTemplate.value)?.min,
        max: DAQ_TEMPLATES.find(t => t.key === addTemplate.value)?.max,
        decimals: DAQ_TEMPLATES.find(t => t.key === addTemplate.value)?.decimals,
      } as never)
    }
    addOpen.value = false
    addName.value = ''
    addTest.value = null
  }
  catch (err) {
    addError.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    addSaving.value = false
  }
}

/** 展示态:控制器暂停或节点停用 → offline(与服务端 effectiveTwinState 同语义) */
function effectiveState(n: { enabled: boolean, state: DaqNodeState }): DaqNodeState {
  if (!daq.controller.running || !n.enabled) return 'offline'
  return n.state
}

/** 模板通道语义(shared 目录单一事实源;daq- 前缀兼容) */
function daqTemplateRefCh(templateRef: string): string {
  const tpl = DAQ_TEMPLATES.find(t => t.key === daqKeyFromRef(templateRef))
  return tpl ? `${tpl.name} · ${tpl.ch}` : templateRef || '-'
}

/** 驱动是否为预留协议(meta status=planned) */
const driverPlanned = (kind: string): boolean =>
  daq.meta.drivers.find(d => d.kind === kind)?.status === 'planned'

const reconnecting = ref(false)
async function doReconnect(): Promise<void> {
  reconnecting.value = true
  try {
    await daq.reconnectInfra()
  }
  catch { /* 横幅仍在,30s 后台也会自动重试 */ }
  finally {
    reconnecting.value = false
  }
}
</script>

<template>
  <div class="page">
    <div class="aw-page-head">
      <div>
        <p class="aw-kicker">
          AGENTWORKSHOP / DAQ CONSOLE
        </p>
        <h1>数采中心</h1>
        <p class="sub">
          采集 → 队列(MQTT)→ 时序库(Timescale)→ WS 实时下发全链路;节点实体与参数以服务端为准。
        </p>
      </div>
      <div class="badges mono">
        <span
          class="badge"
          :title="'时序存储后端:DAQ_TSDB_URL 可切换 TimescaleDB'"
        >TSDB · {{ daq.meta.tsdb }}</span>
        <span
          class="badge"
          :title="'消息队列:DAQ_MQTT_URL 可切换标准 MQTT broker'"
        >QUEUE · {{ daq.meta.queue }}</span>
      </div>
    </div>

    <!-- 基础设施降级横幅(MQTT/Timescale 不可达:在线采集停用 + 一键重连) -->
    <div
      v-if="daq.meta.infra?.degraded"
      class="infra-banner"
    >
      <span class="i-tabler-alert-triangle" />
      <span class="txt">{{ daq.meta.infra.warning }}</span>
      <button
        class="pill-btn"
        :disabled="reconnecting"
        @click="doReconnect"
      >
        {{ reconnecting ? '重连中…' : '重连基础设施' }}
      </button>
    </div>

    <!-- 控制器总控条 -->
    <section class="aw-tile ctrl-card">
      <div class="ctrl-left">
        <button
          class="aw-pill"
          :class="{ running: daq.controller.running }"
          @click="daq.controllerAction(daq.controller.running ? 'stop' : 'start')"
        >
          <span :class="daq.controller.running ? 'i-tabler-player-pause' : 'i-tabler-player-play'" />
          {{ daq.controller.running ? '暂停全部采集' : '恢复全部采集' }}
        </button>
        <label class="cycle mono">
          缺省周期
          <input
            v-model.number="daq.controller.defaultIntervalMs"
            type="number"
            min="200"
            max="60000"
            step="100"
            @change="daq.controllerAction('config', daq.controller.defaultIntervalMs)"
          >ms
        </label>
      </div>
      <div class="ctrl-right">
        <span class="ctrl-metrics mono">
          <span>节点 {{ daq.controller.nodesOnline }}/{{ daq.controller.nodesTotal }}</span>
          <span class="sep">·</span>
          <span title="生产者已发布到队列">发布 {{ daq.meta.produced }}</span>
          <span class="sep">·</span>
          <span title="消费者已从队列取得">消费 {{ daq.meta.consumed }}</span>
          <span class="sep">·</span>
          <span
            :class="{ warn: (daq.meta.dropped ?? 0) > 0 }"
            title="队列丢失(produced-consumed)"
          >丢失 {{ daq.meta.dropped }}</span>
          <span class="sep">·</span>
          <span title="时序库累计入库样本">入库 {{ daq.meta.samplesStored }}</span>
        </span>
        <button
          class="aw-pill add-btn"
          @click="addOpen = true"
        >
          <span class="i-tabler-plus" />
          添加节点
        </button>
      </div>
    </section>

    <!-- 添加节点向导:mock 模拟 / 真实设备(协议参数 + 测试连接) -->
    <div
      v-if="addOpen"
      class="modal-mask"
      @click.self="addOpen = false"
    >
      <div class="modal">
        <h3 class="m-title">
          添加数采节点
        </h3>

        <div class="seg-row">
          <button
            class="seg"
            :class="{ on: addScenario === 'mock' }"
            @click="addScenario = 'mock'"
          >
            Mock 模拟源
          </button>
          <button
            class="seg"
            :class="{ on: addScenario === 'real' }"
            @click="addScenario = 'real'"
          >
            真实设备采集
          </button>
        </div>

        <div class="f-grid">
          <label class="f">
            <span>信号模板(量程/单位域)</span>
            <select
              v-model="addTemplate"
              class="inp"
            >
              <option
                v-for="t in DAQ_TEMPLATES"
                :key="t.key"
                :value="t.key"
              >
                {{ t.name }} · {{ t.ch }}({{ t.min }}~{{ t.max }} {{ t.unit }})
              </option>
            </select>
          </label>
          <label class="f">
            <span>节点名称(可选)</span>
            <input
              v-model="addName"
              class="inp"
              placeholder="缺省按模板自增命名"
            >
          </label>
          <label
            v-if="addScenario === 'real'"
            class="f"
          >
            <span>采样周期 ms(空=跟随全局)</span>
            <input
              v-model.number="addInterval"
              type="number"
              min="200"
              max="60000"
              step="100"
              class="inp"
              placeholder="如 1000"
            >
          </label>
        </div>

        <!-- 真实场景:协议选择 + 动态参数表单 + 测试连接 -->
        <template v-if="addScenario === 'real'">
          <div class="f-grid">
            <label class="f">
              <span>通信协议</span>
              <select
                v-model="addDriver"
                class="inp"
              >
                <option
                  v-for="d in DAQ_DRIVERS.filter(x => x.status !== 'planned')"
                  :key="d.kind"
                  :value="d.kind"
                >
                  {{ d.label }}{{ driverReady(d.kind) ? '' : '(栈未装)' }}
                </option>
              </select>
            </label>
          </div>

          <div
            v-if="addFields.length"
            class="f-grid driver-form"
          >
            <label
              v-for="f in addFields"
              :key="f.key"
              class="f"
            >
              <span>{{ f.label }}<em v-if="f.required">*</em></span>
              <select
                v-if="f.type === 'select'"
                v-model="addCfg[f.key]"
                class="inp"
              >
                <option
                  v-for="o in f.options"
                  :key="o.value"
                  :value="o.value"
                >
                  {{ o.label }}
                </option>
              </select>
              <input
                v-else
                v-model="addCfg[f.key]"
                :type="f.type === 'number' ? 'number' : 'text'"
                :placeholder="f.placeholder"
                class="inp"
              >
              <small
                v-if="f.hint"
                class="hint"
              >{{ f.hint }}</small>
            </label>
          </div>

          <div class="test-row">
            <button
              class="pill-btn"
              :disabled="addTesting"
              @click="doTestConnection"
            >
              {{ addTesting ? '测试中…' : '测试连接' }}
            </button>
            <span
              v-if="addTest"
              class="test-result"
              :class="addTest.ok ? 'ok' : 'bad'"
            >{{ addTest.ok ? '✓' : '✗' }} {{ addTest.message }}<template v-if="addTest.latencyMs != null">({{ addTest.latencyMs }}ms)</template></span>
          </div>
        </template>

        <p
          v-if="addError"
          class="m-err"
        >
          {{ addError }}
        </p>

        <div class="m-actions">
          <button
            class="aw-pill outline"
            @click="addOpen = false"
          >
            取消
          </button>
          <button
            class="aw-pill"
            :disabled="addSaving || (addScenario === 'real' && addTest && !addTest.ok)"
            :title="addScenario === 'real' && !(addTest && addTest.ok) ? '真实场景需先通过测试连接' : ''"
            @click="doAddNode"
          >
            {{ addSaving ? '创建中…' : (addScenario === 'real' ? '测试通过后创建并采集' : '创建节点') }}
          </button>
        </div>
      </div>
    </div>

    <!-- 节点清单 -->
    <a-spin :spinning="!daq.loaded && !daq.error">
      <section class="aw-tile table-card">
        <table class="nodes-table">
          <thead>
            <tr>
              <th>节点</th>
              <th>状态</th>
              <th>实时值</th>
              <th>采样周期</th>
              <th>驱动</th>
              <th>绑定设备</th>
              <th class="right">
                操作
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="n in daq.nodes"
              :key="n.id"
            >
              <td>
                <span class="mono dim">{{ n.id.slice(0, 8) }}</span>
                <b>{{ n.name }}</b>
                <small class="mono ch">{{ daqTemplateRefCh(n.templateRef) }}</small>
              </td>
              <td>
                <span
                  class="st-pill"
                  :class="[effectiveState(n)]"
                >{{ stateLabel[effectiveState(n)] }}</span>
              </td>
              <td class="mono val">
                {{ n.value != null ? n.value.toFixed(n.decimals) : '--' }}
                <small>{{ n.unit }}</small>
              </td>
              <td class="mono">
                {{ intervalOf(n.intervalMs) }}
              </td>
              <td>
                <span
                  class="drv-tag"
                  :class="{ planned: driverPlanned(n.driver) }"
                  :title="driverPlanned(n.driver) ? '预留协议:待真实通道接入' : ''"
                >{{ n.driver }}</span>
              </td>
              <td>{{ deviceName(n.deviceBindingId) }}</td>
              <td class="right">
                <NuxtLink
                  class="console-link"
                  :to="`/daq/${n.id}`"
                >
                  <span class="i-tabler-dashboard" />
                  控制台
                </NuxtLink>
              </td>
            </tr>
            <tr v-if="daq.loaded && daq.nodes.length === 0">
              <td colspan="7">
                <div
                  class="pane-empty"
                  style="min-height: 120px;"
                >
                  <p class="pe-sub">
                    暂无数采节点 —— 在数字孪生空间从左轨「数采节点 · DAQ」拖入即可(server 建立节点实体)。
                  </p>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </a-spin>

    <p
      v-if="daq.error"
      class="err"
    >
      {{ daq.error }}(<NuxtLink to="/workshop">前往登录</NuxtLink>)
    </p>
  </div>
</template>

<style scoped>
.page { padding: 4px; }
h1 { margin: 2px 0 4px; font-size: 30px; font-weight: 400; letter-spacing: -0.015em; }
.sub { margin: 0; font-size: 12.5px; opacity: 0.6; }
.mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.dim { opacity: 0.55; }

.badges { display: flex; gap: 8px; }
.badge {
  padding: 3px 10px;
  font-size: 11px;
  letter-spacing: 0.05em;
  color: var(--ink-soft);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-chip);
}

.ctrl-card {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  margin-bottom: 14px;
}
.ctrl-left { display: flex; gap: 14px; align-items: center; }
.aw-pill.running { background: var(--accent); }
.cycle { display: inline-flex; gap: 6px; align-items: center; font-size: 12px; color: var(--ink-faint); }
.cycle input {
  width: 84px;
  padding: 4px 8px;
  color: var(--ink);
  background: var(--paper-deep);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-chip);
}
.ctrl-metrics { display: flex; gap: 8px; align-items: center; font-size: 11.5px; color: var(--ink-soft); }
.ctrl-metrics .sep { opacity: 0.4; }
.ctrl-metrics .warn { color: var(--tone-warning-dot); }

.table-card { overflow-x: auto; }
.nodes-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.nodes-table th, .nodes-table td { padding: 9px 12px; text-align: left; border-bottom: 1px solid var(--divider-hair); }
.nodes-table th {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-faint);
  border-bottom: 1px solid var(--line-strong);
}
.nodes-table td b { margin-left: 8px; }
.ch { display: block; margin-top: 2px; font-size: 10px; color: var(--ink-faint); }
.right { text-align: right; }
.val { font-size: 13px; }
.val small { margin-left: 3px; color: var(--ink-faint); }

.st-pill {
  display: inline-block;
  padding: 2px 9px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.04em;
  border-radius: var(--radius-pill);
}
.st-pill.ok { color: var(--tone-success-dot); background: var(--tone-success-bg); }
.st-pill.warn { color: var(--tone-warning-dot); background: var(--tone-warning-bg); }
.st-pill.alarm { color: var(--tone-danger-dot); background: var(--tone-danger-bg); }
.st-pill.offline { color: var(--tone-neutral-dot); background: var(--tone-neutral-bg); }

.drv-tag {
  font-family: var(--font-mono);
  font-size: 10.5px;
  padding: 2px 7px;
  border: 1px solid var(--line);
  border-radius: var(--radius-chip);
  color: var(--ink-soft);
}
.drv-tag.planned { opacity: 0.55; border-style: dashed; }

.console-link { display: inline-flex; gap: 5px; align-items: center; font-size: 12.5px; color: var(--accent); }
.err { margin-top: 14px; font-size: 13px; color: var(--tone-danger-dot); }
@media (prefers-reduced-motion: no-preference) {
  .nodes-table tbody tr:hover { background: var(--hover-tint); }
}

.infra-banner {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 10px 14px;
  margin-bottom: 14px;
  color: var(--tone-warning-dot);
  background: var(--tone-warning-bg);
  border: 1px solid color-mix(in srgb, var(--tone-warning-dot) 40%, transparent);
  border-radius: var(--radius-chip);
}
.infra-banner .txt { flex: 1 1 auto; font-size: 12.5px; line-height: 1.5; }
.infra-banner .pill-btn { flex: 0 0 auto; color: var(--paper-raised); }

/* ---------- 添加节点向导 ---------- */
.ctrl-right { display: flex; gap: 12px; align-items: center; }
.add-btn { padding: 8px 16px; font-size: 13px; }
.modal-mask {
  position: fixed;
  z-index: 50;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--scrim);
  backdrop-filter: blur(2px);
}
.modal {
  width: 640px;
  max-width: 94vw;
  max-height: 88vh;
  overflow-y: auto;
  padding: 22px 24px;
  background: var(--paper-raised);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-panel);
  box-shadow: var(--shadow-float);
}
.m-title { margin: 0 0 14px; font-size: 17px; }
.seg-row { display: flex; gap: 8px; margin-bottom: 14px; }
.seg {
  flex: 1;
  padding: 8px 0;
  font-size: 13px;
  cursor: pointer;
  color: var(--ink-faint);
  background: var(--paper-deep);
  border: 1px solid var(--line);
  border-radius: var(--radius-chip);
}
.seg.on {
  font-weight: 600;
  color: var(--on-accent);
  background: var(--accent);
  border-color: var(--accent);
}
.f-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px; }
.driver-form { grid-template-columns: repeat(3, 1fr); }
.f { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: var(--ink-faint); }
.f em { margin-left: 3px; font-style: normal; color: var(--tone-danger-dot); }
.inp {
  width: 100%;
  padding: 6px 9px;
  font-size: 12.5px;
  color: var(--ink);
  background: var(--paper-deep);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-chip);
}
.hint { font-size: 10px; color: var(--ink-fainter); }
.test-row { display: flex; gap: 10px; align-items: center; margin: 6px 0 4px; }
.pill-btn {
  padding: 7px 14px;
  font-size: 12.5px;
  cursor: pointer;
  color: var(--paper-raised);
  background: var(--accent);
  border: 1px solid var(--accent);
  border-radius: var(--radius-pill);
}
.pill-btn:disabled { opacity: 0.5; cursor: default; }
.test-result { font-family: var(--font-mono); font-size: 11px; }
.test-result.ok { color: var(--tone-success-dot); }
.test-result.bad { color: var(--tone-danger-dot); }
.m-err { margin: 8px 0 0; font-size: 12px; color: var(--tone-danger-dot); }
.m-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 16px; }
.aw-pill.outline { color: var(--ink); background: var(--paper-raised); border-color: var(--line-strong); }
</style>
