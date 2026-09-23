/**
 * HITL 全局待办 store:omp ask 对话框 + dcw 工具审批 + 各 harness 原生提问/审批的统一待答视图。
 *
 * 数据源:
 *  - AEP hitl.request/hitl.resolved 帧(v17 起服务端按用户定向推送;频道流 seq 帧与
 *    channelId='' 直推帧各到一次,upsert 按 kind+id 幂等去重;徽标不依赖 channel 订阅)
 *  - GET /api/workshop/hitl/pending 快照(页面挂载/重连后的基线对齐)—— **快照是权威**:
 *    替换式写入,WS 期间漂移的陈旧条目不会残留(例如他端已决策但本端漏帧)
 *
 * 应答统一走 `answer()`(REST /workshop/hitl/respond):
 *  - 409 ALREADY_RESOLVED(他端/引擎已处理)→ 重拉快照收敛,UI 提示"已被他人处理";
 *  - 403 APPROVAL_FORBIDDEN(审批策略 owner_only 或资格快照不收)→ 原样上抛策略文案。
 * 终端面板(omp)另有直连 WS 应答路径,与本 store 互不影响。
 */
import { defineStore } from 'pinia'
import type { AepEnvelope, AepHitlItem } from '#shared/workshop-protocol'
import { useUserStore } from './user'
import { narrowFetch } from './narrow-fetch'
import { apiErrorMessage } from '@/app/utils/api-error'

const keyOf = (i: Pick<AepHitlItem, 'kind' | 'id'>) => `${i.kind}:${i.id}`

interface HitlPendingRes {
  code: number | string
  message?: string
  data?: { items: AepHitlItem[] }
}

interface RespondRes {
  code: number | string
  message?: string
  data?: { ok: boolean, kind: string, id: string }
}

/**
 * 应答体(服务端 `RespondBody` 的客户端侧同构)。
 *
 * 提问型(question)必须用 `answers[]` —— 服务端把它编码成引擎原生信封
 * (`{"x-aw-hitl-answers":[{id,answer}]}`,见 hitl-registry 的 ANSWER_ENVELOPE)。
 * **不要**把多问题手拼成 JSON 字符串塞进 `value`:服务端只按 `answers` 取结构化答案,
 * 拼 JSON 会被当成"单答案文本",逐题解析结果全为空(实测:答案静默丢失但接口返回 ok)。
 */
export interface HitlAnswerPayload {
  /** approval 型:true=放行,false=拒绝(与 cancelled 互斥) */
  confirmed?: boolean
  cancelled?: boolean
  /** 引擎原生选项(opencode permission:once|always|reject;hermes/dsh 选项名) */
  response?: string
  comment?: string
  /**
   * question 型答案(结构化;按问题 id 对齐)。
   * 单问题也可走这里(服务端 `resolveAnswers` 支持"按 id 命中或按下标回退")。
   */
  answers?: Array<{ id?: string, answer: string }>
  /** 纯文本答案(仅单问题/自由文本的兼容路径;多问题请用 answers) */
  value?: string
}

/** 应答结果:ok=false 时 code 为服务端业务码(409 ALREADY_RESOLVED / 403 APPROVAL_FORBIDDEN) */
export interface HitlAnswerOutcome {
  ok: boolean
  code: string
  /** 面向用户的文案(服务端人话优先) */
  message: string
}

/** 从 FetchError/Error 中取业务码(信封 code 优先,其次 HTTP 状态映射) */
function outcomeOf(err: unknown): HitlAnswerOutcome {
  const e = (err ?? {}) as { data?: { code?: string | number }, statusCode?: number, status?: number, response?: { status?: number, data?: { code?: string | number } } }
  const raw = e.data?.code ?? e.response?.data?.code
  const status = Number(e.statusCode ?? e.status ?? e.response?.status ?? 0)
  const code = raw !== undefined && raw !== null
    ? String(raw)
    : (status === 409 ? 'ALREADY_RESOLVED' : status === 403 ? 'APPROVAL_FORBIDDEN' : status ? `HTTP_${status}` : '')
  return { ok: false, code, message: apiErrorMessage(err) }
}

export const useHitlStore = defineStore('workshop.hitl', {
  state: () => ({
    /** 当前待人工处理条目(kind+id 幂等;v17 可选字段 method/options/questions/policy 原样透传) */
    items: [] as AepHitlItem[],
    /** 快照已加载(防重复拉取;WS 掉线重连后由 invalidate 重置) */
    snapshotLoaded: false,
    /** 正在提交的条目 `${kind}:${id}`(按钮 loading / 防重复点击) */
    answering: null as string | null,
  }),
  getters: {
    count: state => state.items.length,
    /** 按 agent 分组(徽标下拉/跳转用) */
    byAgent: (state) => {
      const map = new Map<string, AepHitlItem[]>()
      for (const i of state.items) {
        const list = map.get(i.agentId) ?? []
        list.push(i)
        map.set(i.agentId, list)
      }
      return map
    },
    /** 单条查询(页头按 kind+id 定位当前条目状态) */
    byKey: state => (kind: string, id: string): AepHitlItem | undefined =>
      state.items.find(i => i.kind === kind && i.id === id),
  },
  actions: {
    /** AEP 帧消费(hitl.request / hitl.resolved;幂等 upsert/remove) */
    applyEnvelope(e: AepEnvelope): void {
      if (e.type === 'hitl.request') {
        const item = e.payload as AepHitlItem
        const key = keyOf(item)
        const idx = this.items.findIndex(i => keyOf(i) === key)
        // 整对象替换(不 merge):服务端帧携带权威的新可选字段(questions/method/policy),
        // merge 会让旧值黏附;缺字段时以帧为准(节流快照会补齐)
        if (idx >= 0) this.items[idx] = item
        else this.items.push(item)
      }
      else if (e.type === 'hitl.resolved') {
        const r = e.payload as { kind: AepHitlItem['kind'], id: string }
        this.items = this.items.filter(i => keyOf(i) !== keyOf(r))
      }
    },
    /** 快照对齐(挂载/重连;替换式 —— 以 REST 为准收敛 WS 期间的可能漂移) */
    async loadSnapshot(): Promise<void> {
      if (typeof window === 'undefined') return
      const token = useUserStore().token
      if (!token) return
      try {
        const res = await narrowFetch<HitlPendingRes>('/api/workshop/hitl/pending', {
          headers: { authorization: `Bearer ${token}` },
        })
        if (res.code === 0 && res.data) {
          this.items = res.data.items
          this.snapshotLoaded = true
        }
      }
      catch { /* 快照失败不阻塞实时帧 */ }
    },
    /**
     * 统一应答(REST;页头 ask/审批表单与任何非终端入口共用)。
     * 409/403 不抛出:调用方按 code 渲染"已被他人处理 / 无审批权限"专用提示。
     */
    async answer(item: Pick<AepHitlItem, 'kind' | 'id'>, payload: HitlAnswerPayload): Promise<HitlAnswerOutcome> {
      const key = keyOf(item)
      if (this.answering) return { ok: false, code: 'BUSY', message: '已有应答提交中' }
      this.answering = key
      const token = useUserStore().token
      try {
        const res = await narrowFetch<RespondRes>('/api/workshop/hitl/respond', {
          method: 'POST',
          body: { kind: item.kind, id: item.id, ...payload },
          headers: token ? { authorization: `Bearer ${token}` } : {},
        })
        if (res.code !== 0) {
          // 业务失败(非 2xx 由 ofetch 抛出):同样以快照收敛
          await this.loadSnapshot()
          return { ok: false, code: String(res.code ?? ''), message: res.message ?? '应答失败' }
        }
        // 应答成功 → 本地先行摘除,再以快照收敛(防止按钮可重复点击)
        this.items = this.items.filter(i => keyOf(i) !== key)
        await this.loadSnapshot()
        return { ok: true, code: '', message: res.message ?? 'ok' }
      }
      catch (err) {
        const out = outcomeOf(err)
        // 冲突/越权:以服务端事实源重拉(条目可能已被他人处理,或从待办里消失)
        if (out.code === 'ALREADY_RESOLVED' || out.code === 'APPROVAL_FORBIDDEN' || out.code === 'NOT_RESPONDABLE') {
          await this.loadSnapshot()
        }
        return out
      }
      finally {
        this.answering = null
      }
    },
    /** WS 断线重连后重新对齐 */
    invalidate(): void {
      this.snapshotLoaded = false
    },
    clear(): void {
      this.items = []
      this.snapshotLoaded = false
      this.answering = null
    },
  },
})
