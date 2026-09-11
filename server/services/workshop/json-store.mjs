// ============================================================
// JSON 文件存储原语 —— 全部 JSON 仓库共用(hardening:防数据丢失)。
//
// 背景(2026-09-05 QA 审计 P0-2):各仓库原先直接 writeFileSync 落盘 +
// load 时 catch 后静默返回空库。一次写入中断(崩溃/断电/磁盘满)即产生
// 截断文件,下次启动静默以空库运行,首次落盘用空数据覆盖原文件 ——
// recipes/产线配置/回滚锚点永久丢失。
//
// 约定:
//  - loadJsonFile:损坏时把坏文件保留为 <name>.corrupt-<ts>(现场可追责),
//    再返回 fallback;ENOTDIR/ENOENT 等缺失场景静默 fallback。
//  - saveJsonFileAtomic:先写同目录临时文件再 rename(同卷原子替换);
//    rename 失败(Windows 杀软占用等)退回直写,保证可用性。
// ============================================================
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 读取 JSON 文件;缺失或损坏时返回 fallback。
 * @param {string} filePath
 * @param {unknown} fallback 缺省结构(如 { anchors: [], records: [] } 或 [])
 * @returns
 */
export function loadJsonFile(filePath, fallback) {
  let raw
  try {
    raw = readFileSync(filePath, 'utf-8')
  }
  catch {
    return fallback
  }
  try {
    return JSON.parse(raw)
  }
  catch (err) {
    // 损坏现场保留:改名留档,绝不用空库静默顶替用户数据
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupPath = `${filePath}.corrupt-${stamp}`
    try {
      renameSync(filePath, backupPath)
      console.error(`[json-store] ⚠ ${filePath} 解析失败(${err.message}),坏文件已保留为 ${backupPath},本次以空数据启动`)
    }
    catch {
      console.error(`[json-store] ⚠ ${filePath} 解析失败(${err.message}),且保留坏文件失败,本次以空数据启动`)
    }
    return fallback
  }
}

/**
 * 紧凑 vs 缩进的切换阈值(顶层元素数)。
 *
 * 为什么需要:`null, 2` 缩进对**小文件**是净收益(人可读、diff 友好、成本可忽略),
 * 但对**大库**是纯税:实测 DCW 回退账本 20000 锚 + 2000 记录 — 缩进 8.57 MB / 23.2 ms,
 * 紧凑 5.82 MB / 13.2 ms(体积 -32%、CPU -43%)。而它每个 1.5s 防抖窗就要整库重写一次,
 * 与 PLC 写 sweep 跑在同一个事件循环上 —— 缩进在这里换来的是几十毫秒的阻塞。
 *
 * 所以按规模自动选择:小库保持缩进(可读性),大库走紧凑(性能)。
 * 2000 是实测拐点量级:低于此的库序列化都在亚毫秒,缩进白拿。
 */
const PRETTY_MAX_ENTRIES = 2000

/** 顶层元素数估算(数组取长度;对象取各数组属性长度之和)——用于选择序列化形态 */
function entryCount(data) {
  if (Array.isArray(data)) return data.length
  if (data && typeof data === 'object') {
    let n = 0
    for (const v of Object.values(data)) if (Array.isArray(v)) n += v.length
    return n
  }
  return 0
}

/** 按规模选择缩进(小库可读、大库省 CPU/IO) */
function serializeJson(data) {
  return entryCount(data) > PRETTY_MAX_ENTRIES
    ? JSON.stringify(data)
    : JSON.stringify(data, null, 2)
}

/**
 * 原子落盘:写临时文件 → rename 替换;失败退回直写。
 * 序列化形态按库规模自动选择(见 serializeJson)。
 * @param {string} filePath
 * @param {unknown} data
 */
export function saveJsonFileAtomic(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}`
  const payload = serializeJson(data)
  try {
    writeFileSync(tmp, payload, 'utf-8')
    try {
      renameSync(tmp, filePath)
      return
    }
    catch {
      // rename 失败(目标被占用等):退回直写,可用性优先
    }
  }
  catch (tmpErr) {
    console.error(`[json-store] 临时文件写入失败(${tmpErr.message}),退回直写`)
  }
  writeFileSync(filePath, payload, 'utf-8')
}
