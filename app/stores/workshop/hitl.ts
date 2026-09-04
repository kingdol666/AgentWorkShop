/**
 * HITL 全局待办 store:omp ask 对话框 + dcw 工具审批的统一待答视图。
 *
 * 数据源:
 *  - AEP hitl.request/hitl.resolved 帧(频道流 seq 帧与 channelId='' 全员直推
 *    会各到一次,upsert 按 kind+id 幂等去重;徽标不依赖 channel 订阅)
 *  - GET /api/workshop/hitl/pending 快照(页面挂载/重连后的基线对齐)
 */
import { defineStore } from 'pinia'
import type { AepEnvelope, AepHitlItem } from '#shared/workshop-protocol'
import { useUserStore } from './user'

const keyOf = (i: Pick<AepHitlItem, 'kind' | 'id'>) => `${i.kind}:${i.id}`

interface HitlPendingRes {
  code: number | string
  data?: { items: AepHitlItem[] }
}

export const useHitlStore = defineStore('workshop.hitl', {
  state: () => ({
    /** 当前待人工处理条目(kind+id 幂等) */
    items: [] as AepHitlItem[],
    /** 快照已加载(防重复拉取;WS 掉线重连后由 ensureBaseline 重置) */
    snapshotLoaded: false,
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
  },
  actions: {
    /** AEP 帧消费(hitl.request / hitl.resolved;幂等 upsert/remove) */
    applyEnvelope(e: AepEnvelope): void {
      if (e.type === 'hitl.request') {
        const item = e.payload as AepHitlItem
        const key = keyOf(item)
        const idx = this.items.findIndex(i => keyOf(i) === key)
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
        const res = await $fetch<HitlPendingRes>('/api/workshop/hitl/pending', {
          headers: { authorization: `Bearer ${token}` },
        })
        if (res.code === 0 && res.data) {
          this.items = res.data.items
          this.snapshotLoaded = true
        }
      }
      catch { /* 快照失败不阻塞实时帧 */ }
    },
    /** WS 断线重连后重新对齐 */
    invalidate(): void {
      this.snapshotLoaded = false
    },
    clear(): void {
      this.items = []
      this.snapshotLoaded = false
    },
  },
})
