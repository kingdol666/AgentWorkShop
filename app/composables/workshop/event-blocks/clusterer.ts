/**
 * 增量聚类器:块对象身份稳定,只处理新增帧。
 *
 * 与旧版差异:
 *  - 增量聚类:只处理新增帧,块对象身份稳定(Vue 按 key 复用组件,流式更新不整树重建)
 *  - 内容智能去重:落定全文(status.message/agent.message)与已累计 delta 相同或为前缀扩展时
 *    绝不重复渲染第二遍——修复"连续两次重复渲染"(omp 消息流 delta 与 message_end 全文重复)
 *  - 跨块落定折回:工具调用把流切段时,deltas 累计跨块跟踪,message_end 全文按内容比对折回
 *    最后一段流块;先前流片段标记 coveredBy 折叠为一行提示(OpenHands 风格)
 */
import { reactive } from 'vue'
import type { AepEnvelope } from '#shared/workshop-protocol'
import type { BlockKind, EventBlock } from './types'
import { classifyEvent } from './classify'
import { foldRelation, normText, taskCompatible, taskIdOf, textOf } from './text-utils'

// ===== 累计水路 / 折回 =====

interface StreamTrack {
  text: string
  pieces: EventBlock[]
  last: EventBlock
}

export class BlockClusterer {
  private arr: EventBlock[] = []
  private last: EventBlock | null = null
  private tracks = new Map<string, StreamTrack>()
  private trail: Record<string, string> = Object.create(null)
  private idSeq = 0
  private processed = 0
  /** 上次同步时列表头部事件的 seq(头部变化 = 历史回填插入/ring 裁剪/过滤切换 → 必须全量重建,否则索引错位重复聚类) */
  private headSeq: number | undefined = undefined

  get blocks(): EventBlock[] {
    return this.arr
  }

  get processedCount(): number {
    return this.processed
  }

  reset(): void {
    this.arr.length = 0
    this.last = null
    this.tracks.clear()
    this.trail = Object.create(null)
    this.processed = 0
    this.headSeq = undefined
  }

  /**
   * 序列同步:只处理新增帧。列表头部 seq 变化(loadHistory 头部插入历史帧并整体
   * 排序 / ring 容量裁剪 / 过滤切换)时,已处理事件整体右移——按索引继续会把已
   * 聚类事件重复成块,故检测到头部变化即全量重建(一次重建,确定性无重复)。
   */
  sync(events: AepEnvelope[]): void {
    const head = events.length > 0 ? events[0]?.seq : undefined
    if (events.length < this.processed || head !== this.headSeq) this.reset()
    for (let i = this.processed; i < events.length; i++) this.push(events[i]!)
    this.processed = events.length
    this.headSeq = events.length > 0 ? events[0]?.seq : undefined
  }

  push(e: AepEnvelope): EventBlock | null {
    if (e.type === 'channel.snapshot' || e.type === 'pong') return this.last

    // 空内容帧抑制(空白块根因):空 delta / 纯空白落定文本不成块不合并。
    // 服务端已守卫新增帧;此处兜底历史库旧帧与漏网路径——保证"思考/中间输出"
    // 类块永远有实质内容,不再出现空白折叠行。
    if (e.type === 'agent.delta' && !textOf(e)) return this.last
    if ((e.type === 'agent.status.message' || e.type === 'agent.message') && !textOf(e).trim()) return this.last

    const agentId = e.agentId ?? null
    const taskId = taskIdOf(e)
    const agentKey = agentId ?? ''
    const trackKey = `${agentKey}\u0000${taskId ?? ''}`
    const baseKind = classifyEvent(e)

    // ① 流式落定帧 — 内容重复判断:折回已累计流的重复正文
    if (e.type === 'agent.status.message' && baseKind === 'status') {
      const t = textOf(e).trim()
      const track = this.tracks.get(trackKey)
      if (t && track && track.text) {
        const rel = foldRelation(track.text, t)
        if (rel === 'dup' || rel === 'extend') {
          return this.foldInto(track, e, t)
        }
      }
    }
    if (e.type === 'agent.message') {
      const t = textOf(e).trim()
      const track = this.tracks.get(trackKey)
      if (t && track && track.text) {
        const rel = foldRelation(track.text, t)
        if (rel === 'dup' || rel === 'extend') {
          return this.foldInto(track, e, t)
        }
      }
    }

    // ② 解析块类别:
    //  delta/message 直接走 stream;status.message 非🔧(未折回)保持 status,
    //  除非紧邻一个同源 OPEN 流块(消息直接跟在 delta 流后面,合并进同一个气泡)
    let kind: BlockKind = baseKind
    if (e.type === 'agent.delta') {
      kind = 'stream'
    }
    else if (e.type === 'agent.message') {
      kind = 'stream'
    }
    else if (baseKind === 'status') {
      const lb = this.last
      const adjacentOpenStream = lb !== null
        && lb.kind === 'stream'
        && e.agentId === lb.agentId
        && taskCompatible(lb.taskId, taskId)
        && !lb.settled
      if (adjacentOpenStream) kind = 'stream'
    }

    // ③ 合并判断 — 稳定块身份(delta 流型高频追加)
    const mergeable = this.last !== null
      && this.last.kind === kind
      && this.last.agentId === e.agentId
      && agentId !== null
      && taskCompatible(this.last.taskId, taskId)
      && !(kind === 'stream' && this.last.settled)
      && !(kind === 'task' && this.last.taskId && taskId && this.last.taskId !== taskId)
      && !(kind === 'artifact' && this.last.taskId && taskId && this.last.taskId !== taskId)
    if (mergeable && this.last) {
      const b = this.last
      b.events.push(e)
      b.lastAt = e.at
      if (kind === 'stream') {
        if (e.type === 'agent.delta') {
          b.settled = false
          const t = this.tracks.get(trackKey)
          if (t) {
            t.text += textOf(e)
            t.last = b
            this.setTrail(agentKey, taskId, t.text)
          }
          else {
            b.settled = false
            this.setTrail(agentKey, taskId, textOf(e))
          }
        }
        else {
          // 落定 message 相邻合并:落定收口(不清除 render 文本)
          b.settled = true
          this.setTrail(agentKey, taskId, `${textOf(e)}`)
        }
      }
      return b
    }

    // ④ 新块(reactive 化:块内 events.push / settled / overrideText 等原地变更
    //    能触发消费方(EventBlock/ClusterStream)的 computed 实时更新)
    const block: EventBlock = reactive({
      id: `b${++this.idSeq}`,
      kind,
      agentId,
      taskId,
      events: [e],
      firstAt: e.at,
      lastAt: e.at,
      settled: kind === 'stream' ? e.type !== 'agent.delta' : false,
      folded: 0,
      overrideText: null,
      coveredBy: null,
      dupStream: false,
    })
    this.arr.push(block)
    this.last = block

    if (kind === 'stream') {
      const tk = this.tracks.get(trackKey)
      if (tk && tk.pieces.length > 0 && !tk.pieces.includes(block)) {
        tk.pieces.push(block)
        tk.last = block
      }
      else if (!tk) {
        this.tracks.set(trackKey, {
          text: '',
          pieces: [block],
          last: block,
        })
      }
      if (e.type === 'agent.delta') {
        const t = this.tracks.get(trackKey)
        if (t) {
          t.text += textOf(e)
          this.setTrail(agentKey, taskId, t.text)
        }
      }
    }
    if (kind === 'artifact') {
      const t = textOf(e)
      const prior = this.trail[trackKey] ?? this.trail[`${agentKey}\u0000`]
      if (prior && t && normText(prior) === normText(t)) {
        block.dupStream = true
      }
    }
    return block
  }

  /** 内容重复折回:已累计流足够覆盖时不再成块;折回块重渲染一律以落定全文为准
   *  (跨工具切段折回时,目标块只含尾部 delta,不覆盖全文则文本被截断) */
  private foldInto(track: StreamTrack, e: AepEnvelope, text: string): EventBlock {
    const target = track.last
    target.events.push(e)
    target.folded += 1
    target.lastAt = e.at
    target.settled = true
    target.overrideText = text
    // 前序流片段被本次落定文本覆盖 → 折叠为提示行
    for (const p of track.pieces) {
      if (p !== target) p.coveredBy = target.id
    }
    track.text = ''
    track.pieces = [target]
    track.last = target
    this.setTrail(target.agentId ?? '', target.taskId, text)
    return target
  }

  private setTrail(agentKey: string, taskId: string | null, text: string): void {
    this.trail[`${agentKey}\u0000${taskId ?? ''}`] = text
  }
}
