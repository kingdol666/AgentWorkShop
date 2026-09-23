/**
 * AML 概览条 + 运行环境(uv 检测 / 一键安装 / .venv 供给)+ 元数据↔实体对账。
 * 三块同源于 GET /api/workshop/aml(、/env、/entities),且环境任务轮询会顺带收敛概览条,
 * 因此合成一个实例:页面只创建一次,状态下发给「概览条 / 运行环境面板」两个子组件。
 */
import { computed, ref } from 'vue'
import { message } from 'ant-design-vue'
import { amlApi } from '../api'
import { AML_BLOCKER_KEYS, AML_ROOT_SOURCE_KEYS, AML_UV_SOURCE_LABELS } from '../constants'
import type { AmlEnvStatus, AmlInventory, AmlOverview } from '../types'

export function useAmlEnv() {
  const { t: tt } = useI18n()

  // ---------- 1. 概览条 ----------

  const overview = ref<AmlOverview | null>(null)
  const overviewError = ref('')

  async function loadOverview(): Promise<void> {
    try {
      overview.value = await amlApi<AmlOverview>('')
      overviewError.value = ''
    }
    catch (err) {
      overviewError.value = apiErrorMessage(err)
    }
  }

  const pythonText = computed(() => {
    const rt = overview.value?.runtime
    if (!rt) return '--'
    return rt.python.ok ? (rt.python.version ?? tt('aml.k1amlx004')) : tt('aml.k1amlx005')
  })
  const venvText = computed(() =>
    overview.value ? (overview.value.runtime.venvReady ? tt('aml.k1amlx007') : tt('aml.k1amlx008')) : '--')

  // ---------- 1b. 运行环境(uv 检测 / 一键安装 / .venv 供给) ----------

  /** 完整环境状态(GET /env);比 overview.env 多出任务日志与目录明细 */
  const env = ref<AmlEnvStatus | null>(null)
  const envBusy = ref(false)
  /** 与环境任务日志区配对的开关(原页面保留的历史状态,当前模板未读取) */
  const envLogOpen = ref(false)

  /** 服务端 blocker 是中文数据:已知固定文案映射 i18n,未知(动态 reason)原样透传 */
  const blockerText = computed(() =>
    (env.value?.preflight?.blockers ?? [])
      .map(b => (AML_BLOCKER_KEYS[b] ? tt(AML_BLOCKER_KEYS[b]) : b))
      .join(' / '))

  /** 数据根来源按 amlRootMode 翻译(amlRootSource 是服务端中文标签) */
  const rootSourceLabel = computed(() => {
    const mode = env.value?.amlRootMode ?? ''
    const key = AML_ROOT_SOURCE_KEYS[mode]
    return key ? tt(key) : (env.value?.amlRootSource ?? '')
  })

  const uvText = computed(() => {
    const u = env.value?.uv ?? overview.value?.env?.uv
    if (!u) return '--'
    return u.ok ? (u.version ?? tt('aml.k1amlx164')) : tt('aml.k1amlx165')
  })
  /** uv 来源的中文标签(排障:是配置指定、项目本地装的,还是系统 PATH 上的) */
  const uvSourceText = computed(() => {
    const s = (env.value?.uv ?? overview.value?.env?.uv)?.source
    return s ? (AML_UV_SOURCE_LABELS[s] ?? s) : ''
  })

  async function loadEnv(): Promise<void> {
    try {
      env.value = await amlApi<AmlEnvStatus>('/env')
    }
    catch { /* 概览条已呈现错误;环境面板静默保持旧值 */ }
  }

  /** 环境任务进行中 → 轮询刷新(安装 uv / 建 venv 都是分钟级,不能靠用户手点刷新) */
  let envPollTimer: ReturnType<typeof setInterval> | null = null
  function stopEnvPoll(): void {
    if (envPollTimer != null) {
      clearInterval(envPollTimer)
      envPollTimer = null
    }
  }
  function startEnvPoll(): void {
    stopEnvPoll()
    envPollTimer = setInterval(() => {
      void (async () => {
        await loadEnv()
        await loadOverview()
        if (env.value?.task == null || env.value.task.status !== 'running') {
          stopEnvPoll()
          envBusy.value = false
        }
      })()
    }, 1500)
  }

  async function runEnvAction(path: string, body?: Record<string, unknown>): Promise<void> {
    envBusy.value = true
    envLogOpen.value = true
    try {
      await amlApi(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      await loadEnv()
      startEnvPoll()
    }
    catch (err) {
      envBusy.value = false
      message.error(`${tt('aml.k1amlx203')}:${apiErrorMessage(err)}`)
    }
  }

  /** 一键安装 uv(装到 ./aml/tools,免管理员、不改 PATH) */
  async function installUv(): Promise<void> {
    await runEnvAction('/env/uv')
  }

  /** 创建/重建训练环境 ./aml/.venv */
  async function createVenv(force = false): Promise<void> {
    await runEnvAction('/env/venv', { force })
  }

  /** 重新探测(用户在系统里手工装了 uv/Python 后免重启生效) */
  async function recheckEnv(): Promise<void> {
    envBusy.value = true
    try {
      env.value = await amlApi<AmlEnvStatus>('/env/recheck', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      await loadOverview()
    }
    catch (err) {
      message.error(`${tt('aml.k1amlx203')}:${apiErrorMessage(err)}`)
    }
    finally {
      envBusy.value = false
    }
  }

  // ---------- 1c. 元数据 ↔ 实体 对账 ----------

  const inventory = ref<AmlInventory | null>(null)

  async function loadInventory(): Promise<void> {
    try {
      inventory.value = await amlApi<AmlInventory>('/entities')
    }
    catch { /* 静默 */ }
  }

  async function pruneOrphans(): Promise<void> {
    try {
      const r = await amlApi<{ removed: string[], kept: number }>('/entities/prune', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dryRun: false }),
      })
      message.success(`${tt('aml.k1amlx188')}:${r.removed.length}`)
      await loadInventory()
    }
    catch (err) {
      message.error(`${tt('aml.k1amlx203')}:${apiErrorMessage(err)}`)
    }
  }

  return {
    overview,
    overviewError,
    pythonText,
    venvText,
    env,
    envBusy,
    envLogOpen,
    blockerText,
    rootSourceLabel,
    uvText,
    uvSourceText,
    inventory,
    loadOverview,
    loadEnv,
    loadInventory,
    startEnvPoll,
    stopEnvPoll,
    installUv,
    createVenv,
    recheckEnv,
    pruneOrphans,
  }
}
