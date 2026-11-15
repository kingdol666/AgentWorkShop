// ============================================================
// 意图停机标记（`aw stop` 与监管父进程之间的握手）—— 零依赖，
// 服务端 / 启动脚本 / CLI 通用。
// ------------------------------------------------------------
// 问题：`aw stop` 走 HTTP 触发 nitro 的 close 钩子后，服务子进程以退出码 0
// 结束；监管父进程(scripts/start.mjs)此前把任何子进程退出都当崩溃并自动
// 重启 —— "停不掉"且白等 12s 才回退强杀。
//
// 协议：
//   ① 停机端点（server/api/system/shutdown.post.ts）在退出前把本次实例的
//      AW_STOP_TOKEN 写进 <configRoot>/.runtime/stop-intent；
//   ② 父进程在子进程退出时调用 isIntentionalStop()：退出码 0 且标记内容
//      与本次启动令牌一致 → 意图停机，不再重启，清理标记后自行退出；
//   ③ 标记路径只由受信配置根推导，不接受请求/环境变量里的路径；固定文件名
//      且必须落在 <configRoot>/.runtime 内（配置根逃逸一律拒绝）。
// ============================================================
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve, sep } from 'node:path'

const INTENT_FILENAME = 'stop-intent'

/**
 * 解析标记文件路径。
 * configRoot 必须是绝对路径；结果固定为 <configRoot>/.runtime/stop-intent，
 * 并校验规范化后仍位于配置根内（异常根/多级逃逸 → null，调用方 fail-closed）。
 * @param {string} configRoot 受信配置根（resolveRunMode().configRoot）
 * @returns {string|null}
 */
export function stopIntentPath(configRoot) {
  if (typeof configRoot !== 'string' || !configRoot.trim()) return null
  if (!isAbsolute(configRoot)) return null
  const root = resolve(configRoot)
  const runtimeDir = resolve(root, '.runtime')
  if (!runtimeDir.startsWith(`${root}${sep}`)) return null
  const target = resolve(runtimeDir, INTENT_FILENAME)
  if (!target.startsWith(`${runtimeDir}${sep}`)) return null
  return target
}

/** 写入意图停机标记；返回是否成功（失败由调用方记录，不影响停机本身）。 */
export function writeStopIntent(configRoot, token) {
  const target = stopIntentPath(configRoot)
  if (!target) return false
  const body = String(token ?? '')
  if (!body) return false
  try {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, body, { encoding: 'utf8', mode: 0o600 })
    return true
  }
  catch {
    return false
  }
}

/** 读取标记内容（缺失/不可读 → 空串）。 */
export function readStopIntent(configRoot) {
  const target = stopIntentPath(configRoot)
  if (!target) return ''
  try {
    return readFileSync(target, 'utf8').trim()
  }
  catch {
    return ''
  }
}

/** 清理标记（陈旧标记会在下次启动前被清掉，这里供停机/退出路径复用）。 */
export function clearStopIntent(configRoot) {
  const target = stopIntentPath(configRoot)
  if (!target) return
  try {
    rmSync(target, { force: true })
  }
  catch { /* 清理失败不阻断停机 */ }
}

/**
 * 判定一次子进程退出是否为意图停机。
 * 只有"退出码 0 + 无信号 + 标记与本次启动令牌完全一致"三条同时满足才为真；
 * 任何异常退出即便标记存在也不会被误判。
 * @param {string} configRoot
 * @param {string} token 本次启动写入子进程 env 的 AW_STOP_TOKEN
 * @param {{ exitCode?: number|null, signal?: string|null }} exit
 */
export function isIntentionalStop(configRoot, token, { exitCode, signal } = {}) {
  if (exitCode !== 0 || signal) return false
  const expected = String(token ?? '')
  if (!expected) return false
  const got = readStopIntent(configRoot)
  return got.length === expected.length && got === expected
}

export default {
  stopIntentPath,
  writeStopIntent,
  readStopIntent,
  clearStopIntent,
  isIntentionalStop,
}
