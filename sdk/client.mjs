// ============================================================
// AgentWorkShop SDK — 客户端插件上下文工厂（客户端 loader 调用）
// ------------------------------------------------------------
// 插件 client.mjs 导出:
//   export function setup(ctx) { ctx.on('daq.reading', d => { ... }) }
// ctx 形态(浏览器侧,自包含、零框架依赖):
//   ctx.name / ctx.sdkVersion
//   ctx.hooks   客户端本地 HookBus(client:init / event:* / page:change)
//   ctx.on(type, fn)      scene 实时事件订阅(与 WS 同源;'*' 通配)
//   ctx.el(tag, attrs, children)   DOM 助手(挂到任意面板/宿主节点)
//   ctx.mount(selector|el, node)   挂载节点(缺失时挂 body 角落)
//   ctx.log   前缀 console
//   ctx.root  插件 UI 挂载点(懒创建,自动附加到 body,#aw-plugin-<name>)
// ============================================================
import { HookBus } from './hooks.mjs'

export const CLIENT_SDK_VERSION = '0.2.2'

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

export function createClientContext({ name, eventBridge }) {
  const hooks = new HookBus({ name: `client:${name}`, onError: err => console.warn(`[aw-plugin:${name}]`, err) })
  let rootEl = null

  const ctx = {
    name,
    sdkVersion: CLIENT_SDK_VERSION,
    hooks,
    on: (type, fn) => (type === 'event:*' ? hooks.on('*', fn) : hooks.on(`event:${type}`, fn)),
    off: (type, fn) => (type === 'event:*' ? hooks.off('*', fn) : hooks.off(`event:${type}`, fn)),
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
  }

  // scene 事件桥 → ctx.hooks(event:<type> 与 '*' 均可订阅)
  if (eventBridge) {
    eventBridge((type, payload) => {
      void hooks.emit(`event:${type}`, payload)
    })
  }

  return ctx
}

export default { CLIENT_SDK_VERSION, createClientContext, el }
