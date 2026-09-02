// ============================================================
// AgentWorkShop SDK — 客户端插件上下文工厂（客户端 loader 调用）
// ------------------------------------------------------------
// 插件 client.mjs 导出:
//   export function setup(ctx) { ctx.on('daq.reading', d => { ... }) }
// ctx 形态(浏览器侧,自包含、零框架依赖):
//   ctx.name / ctx.sdkVersion
//   ctx.hooks   客户端本地 HookBus(client:init / event:* / page:change / client:destroy)
//   ctx.on(type, fn)      scene 实时事件订阅(与 WS 同源;'*' 通配)——自动登记 pagehide 回收
//   ctx.fetch(path, …)    同源平台 API 助手(JSON;自动解信封 data)
//   ctx.el(tag, attrs, children)   DOM 助手(挂到任意面板/宿主节点)
//   ctx.mount(selector|el, node)   挂载节点(缺失时挂 body 角落)
//   ctx.root  插件 UI 挂载点(懒创建,自动附加到 body,#aw-plugin-<name>)
//   ctx.log   前缀 console
//   ctx.dispose()  卸载:清空挂载点 + 回收订阅 + 广播 client:destroy(pagehide 自动触发)
// ============================================================
import { HookBus } from './hooks.mjs'

export const CLIENT_SDK_VERSION = '0.3.0'

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style') node.style.cssText = v
    else if (k === 'class') node.className = v
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v)
    else node.setAttribute(k, String(v))
  }
  for (const c of [].concat(children)) {
    node.append(typeof c === 'string' ? document.createTextNode(c) : c)
  }
  return node
}

export function createClientContext({ name, eventBridge, baseUrl = '' }) {
  const hooks = new HookBus({ name: `client:${name}`, onError: err => console.warn(`[aw-plugin:${name}]`, err) })
  const disposables = []
  let rootEl = null
  let disposed = false

  const ctx = {
    name,
    sdkVersion: CLIENT_SDK_VERSION,
    hooks,
    on: (type, fn) => {
      const off = type === 'event:*' ? hooks.on('*', fn) : hooks.on(`event:${type}`, fn)
      disposables.push(off)
      return off
    },
    /** 同源平台 API(JSON;自动解 {data} 信封;非 2xx 抛错) */
    fetch: async (path, opt = {}) => {
      const res = await fetch(`${baseUrl}${path}`, {
        headers: { accept: 'application/json', ...(opt.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opt.headers ?? {}) },
        method: opt.method ?? (opt.body !== undefined ? 'POST' : 'GET'),
        body: opt.body !== undefined ? JSON.stringify(opt.body) : undefined,
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) {
        const err = new Error(json?.message ?? `HTTP ${res.status} ${path}`)
        err.status = res.status
        throw err
      }
      return json && typeof json === 'object' && 'data' in json ? json.data : json
    },
    el,
    log: {
      info: (...a) => console.info(`[aw-plugin:${name}]`, ...a),
      warn: (...a) => console.warn(`[aw-plugin:${name}]`, ...a),
      error: (...a) => console.error(`[aw-plugin:${name}]`, ...a),
    },
    root: () => {
      rootEl ??= (() => {
        const found = document.getElementById(`aw-plugin-${name}`)
        if (found) return found
        const box = el('div', { id: `aw-plugin-${name}`, style: 'position:fixed;right:16px;bottom:16px;z-index:2147483000;font:12px/1.6 ui-monospace,monospace' })
        document.body.append(box)
        return box
      })()
      return rootEl
    },
    mount: (target, node) => {
      const host = typeof target === 'string' ? document.querySelector(target) : target
      ;(host ?? ctx.root()).append(node)
      return node
    },
    /** 卸载:回收订阅 + 清空挂载点 + 广播 client:destroy(幂等) */
    dispose: () => {
      if (disposed) return
      disposed = true
      void hooks.emit('client:destroy', { name })
      for (const d of disposables.splice(0)) {
        try {
          d()
        }
        catch { /* 单个回收失败不阻断 */ }
      }
      rootEl?.remove()
      rootEl = null
    },
  }

  // scene 事件桥 → ctx.hooks(event:<type> 与 '*' 均可订阅)
  if (eventBridge) {
    const offBridge = eventBridge((type, payload) => {
      void hooks.emit(`event:${type}`, payload)
    })
    disposables.push(offBridge)
  }

  // 页面卸载自动回收(pagehide 覆盖 bfcache 场景)
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') ctx.dispose()
    }, { once: true })
  }

  return ctx
}

export default { CLIENT_SDK_VERSION, createClientContext, el }
