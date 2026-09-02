// ============================================================
// AgentWorkShop SDK — HookBus（插件生命周期钩子总线）
// ------------------------------------------------------------
// 设计:
//   · 异步串行触发(监听器按注册序 await,可返回值形成 waterfall)
//   · 错误隔离:单监听器抛错不影响其他监听器,错误经 onError 上报
//   · 支持通配符 '*'(接收 { type, payload })
//   · 连续失败自动摘除(熔断):同一监听器连续失败超阈值自动停用,
//     防止病态插件拖垮事件桥
// ============================================================

const FAILLIMIT = 8

export class HookBus {
  constructor({ name = 'hooks', onError } = {}) {
    this.name = name
    this.onError = onError ?? (() => {})
    /** type → Array<{ fn, fails }> */
    this.listeners = new Map()
    this.count = 0
  }

  /** 注册监听器;type='*' 接收全部事件({type,payload})。返回解绑函数 */
  on(type, fn) {
    if (typeof type !== 'string' || typeof fn !== 'function') return () => {}
    const list = this.listeners.get(type) ?? []
    list.push({ fn, fails: 0 })
    this.listeners.set(type, list)
    this.count++
    return () => this.off(type, fn)
  }

  /** 一次性监听(触发后自动解绑) */
  once(type, fn) {
    const off = this.on(type, async (arg) => {
      off()
      return fn(arg)
    })
    return off
  }

  off(type, fn) {
    const list = this.listeners.get(type)
    if (!list) return
    const idx = list.findIndex(l => l.fn === fn)
    if (idx >= 0) {
      list.splice(idx, 1)
      this.count--
    }
    if (!list.length) this.listeners.delete(type)
  }

  /**
   * 触发事件:同名监听器按注册序串行 await;返回最后一个非 undefined 返回值。
   * emit 永不抛错——监听器错误被隔离并计数,连续超限自动摘除(熔断)。
   */
  async emit(type, payload) {
    const same = this.listeners.get(type)
    const wild = this.listeners.get('*')
    let result
    if (same) {
      for (const l of [...same]) {
        const r = await this.#invoke(type, l, payload)
        if (r !== undefined) result = r
      }
    }
    if (wild) {
      for (const l of [...wild]) {
        await this.#invoke('*', l, { type, payload })
      }
    }
    return result
  }

  async #invoke(type, l, payload) {
    try {
      return await l.fn(payload)
    }
    catch (err) {
      l.fails++
      try {
        this.onError(err, { bus: this.name, type, fails: l.fails })
      }
      catch { /* 上报器自身错误忽略 */ }
      if (l.fails >= FAILLIMIT) {
        const list = this.listeners.get(type)
        const idx = list?.indexOf(l) ?? -1
        if (idx >= 0) {
          list.splice(idx, 1)
          this.count--
        }
      }
      return undefined
    }
  }

  /** 已注册监听器总数(诊断用) */
  get size() {
    return this.count
  }
}

export default HookBus
