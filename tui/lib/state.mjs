// ============================================================
// TuiState —— 全局共享状态(单一对象 + 订阅通知;组件渲染时读取)。
// 纯数据,不含行为;帧归约逻辑在 reducers.mjs(可单测)。
// ============================================================
import { EventEmitter } from 'node:events'

export const LOG_CAP = 400

/** 日志行:{ id, kind, agentName?, text, at }
 *  kind: system|user|agent|stream|task|hitl|hitl-resolved|error|monitor|notice */
export function createState() {
  const emitter = new EventEmitter()
  emitter.setMaxListeners(20)

  const state = {
    baseUrl: '',
    token: '',
    userName: '',

    connState: 'closed', // closed|connecting|open
    channels: [],
    activeChannelId: null,
    agents: [], // channel 成员实例:{ id, name, role, harness, enabled }
    agentStates: {}, // agentId → { state, currentTaskId, queued, completed }
    tasks: [],

    hitl: [], // AepHitlItem[]
    /** 正在作答的条目(index → /hitl <n>;null = 常规输入) */
    hitlAnswering: null,

    monitor: {
      agentId: null,
      name: null,
      connected: false,
      waiting: false, // omp 未 spawn(NO_SESSION 重试等待)
      streaming: false,
      lines: [], // { text, tone: dim|info|warn|error|accent }
      streamText: '', // message_update 聚合行(尾部)
    },

    /** 瞬时状态条消息(命令回执;几行内自然被后续输出顶走) */
    statusMsg: '',
    statusAt: 0,
  }

  return {
    state,
    /** 组件注册重渲染回调(requestRender) */
    onChange(fn) {
      emitter.on('change', fn)
      return () => emitter.off('change', fn)
    },
    /** 归约器/命令改状态后调用 → 触发一帧渲染 */
    notify() {
      emitter.emit('change')
    },
  }
}

/** 追加日志行(封顶裁剪);返回该行 id */
export function pushLog(state, kind, text, extra = {}) {
  const row = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    kind,
    text,
    agentName: extra.agentName ?? '',
    agentId: extra.agentId ?? null,
    taskId: extra.taskId ?? null,
    at: new Date(),
  }
  state.log.push(row)
  if (state.log.length > LOG_CAP) state.log.splice(0, state.log.length - LOG_CAP)
  return row
}

/** TUI 挂载 log 数组(state.log 由宿主初始化;此处类型聚合,便于单测构造) */
export function withLog(state) {
  state.log ??= []
  return state
}
