/**
 * 单插件启停 / 状态文件监听 / 宿主查询
 * (由 server/services/workshop/plugins/host.mjs 按职责拆出;内容逐行原文搬运)
 */
import { dirname } from 'node:path'
import { existsSync, mkdirSync, statSync, watch } from 'node:fs'
import { getPluginHost } from './api.mjs'
import { modePaths } from './config.mjs'
import { readDisabledSet, statePathFor, writeDisabledSet } from './state.mjs'
import { reloadPluginHost } from './reload.mjs'

export function setPluginEnabled(name, enabled) {
  const host = getPluginHost()
  const homeDir = modePaths(host?.cwd ?? process.cwd()).homeDir
  const set = readDisabledSet(homeDir)
  if (enabled) set.delete(name)
  else set.add(name)
  writeDisabledSet(homeDir, set)
  return [...set]
}

/** 状态文件监视 → 热重载(CLI/Web 只写文件,服务自感知)。
 *  双保险:fs.watch 的 rename 事件在 Windows 上可能丢名字/丢事件(tmp+rename 原子写
 *  尤其如此)→ 另设 10s 轮询比对 mtime,确保启停/热重载事件绝不丢失。 */
export function ensureStateWatcher(host) {
  const statePath = statePathFor(modePaths(host.cwd).homeDir)
  let lastMtime = 0
  let debounce = null
  const onChange = () => {
    clearTimeout(debounce)
    debounce = setTimeout(() => {
      void reloadPluginHost()
    }, 400)
  }
  try {
    mkdirSync(dirname(statePath), { recursive: true })
    if (!existsSync(statePath)) writeDisabledSet(modePaths(host.cwd).homeDir, new Set())
    lastMtime = existsSync(statePath) ? statSync(statePath).mtimeMs : 0
    // watch 目录而非文件:writeDisabledSet 用 rename 原子替换,POSIX 的文件级
    // watch 挂在旧 inode 上,首次启停后静默失效;目录监听对 rename 稳定
    watch(dirname(statePath), (_event, filename) => {
      if (filename && filename !== 'plugins-state.json') return
      onChange()
    })
  }
  catch (err) {
    host.logger.warn('状态文件监视不可用(启停需手动重启):', err?.message)
  }
  // 轮询兜底(与 watch 互冗余;reloadPluginHost 幂等且并发合并)
  const poll = setInterval(() => {
    try {
      if (!existsSync(statePath)) return
      const m = statSync(statePath).mtimeMs
      if (m !== lastMtime) {
        lastMtime = m
        onChange()
      }
    }
    catch { /* 文件正被替换:下一轮再看 */ }
  }, 10_000)
  poll.unref?.()
}

/** 单例访问(未初始化返回 null —— 桥接点据此快速 no-op) */
